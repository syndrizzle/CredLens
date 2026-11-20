from contextlib import contextmanager
from urllib.parse import quote
from uuid import UUID

from fastapi import FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from app.analysis import analyse
from app.auth import (
    SESSION_COOKIE,
    SESSION_MAX_AGE,
    authenticate_account,
    register_account,
    resolve_session,
    revoke_session,
)
from app.database import check_database, get_engine
from app.document_ingress import DocumentUploadGuard
from app.documents import (
    DocumentRejectError,
    delete_document,
    extract_ready_document,
    get_document_extraction,
    get_document_file,
    list_documents,
    retry_document_processing,
    upload_and_process_document,
)
from app.persistence import (
    InvalidFigureSourceError,
    list_businesses,
    load_analysis,
    load_workspace,
    save_analysis,
    save_business,
    update_business,
)
from app.qa import answer_workspace_question, load_qa_context
from app.retrieval import EmbeddingUnavailableError, retrieve_passages
from app.schemas import (
    AnalysisRequest,
    AnalysisResponse,
    AnalysisRunResponse,
    BusinessSummary,
    CredentialsRequest,
    DocumentExtractionResponse,
    DocumentSummary,
    QARequest,
    QAResponse,
    RetrievalRequest,
    RetrievalResponse,
    SessionResponse,
    UpdateBusinessRequest,
    WorkspaceResponse,
)

app = FastAPI(title="CredLens", version="0.1.0")
app.add_middleware(DocumentUploadGuard)


@contextmanager
def db_transaction():
    try:
        with get_engine().begin() as connection:
            yield connection
    except (RuntimeError, SQLAlchemyError):
        raise HTTPException(status_code=503, detail="Database unavailable") from None


def set_session_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )


def require_session(connection, request: Request) -> SessionResponse:
    try:
        return resolve_session(connection, request.cookies.get(SESSION_COOKIE))
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from None


@app.exception_handler(RequestValidationError)
async def validation_error(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    # Return field errors without including submitted financial values or validator context.
    return JSONResponse(
        status_code=422,
        content={
            "detail": [
                {"loc": list(error["loc"]), "type": error["type"], "msg": error["msg"]}
                for error in exc.errors()
            ]
        },
    )


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/validate", response_model=AnalysisRequest)
def validate_figures(payload: AnalysisRequest) -> AnalysisRequest:
    return payload


@app.post("/api/analysis", response_model=AnalysisResponse)
def analyse_figures(payload: AnalysisRequest) -> AnalysisResponse:
    return analyse(payload)


@app.get("/api/health/database")
def database_health() -> dict[str, str]:
    try:
        check_database()
    except (RuntimeError, SQLAlchemyError):
        raise HTTPException(status_code=503, detail="Database unavailable") from None
    return {"status": "ok", "database": "connected"}


@app.post("/api/auth/register", response_model=SessionResponse, status_code=201)
def register(
    payload: CredentialsRequest, request: Request, response: Response
) -> SessionResponse:
    with db_transaction() as connection:
        try:
            session, token = register_account(
                connection, payload.email, payload.password
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None
    set_session_cookie(response, request, token)
    return session


@app.post("/api/auth/login", response_model=SessionResponse)
def login(
    payload: CredentialsRequest, request: Request, response: Response
) -> SessionResponse:
    with db_transaction() as connection:
        try:
            session, token = authenticate_account(
                connection, payload.email, payload.password
            )
        except PermissionError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from None
    set_session_cookie(response, request, token)
    return session


@app.post("/api/auth/logout")
def logout(request: Request, response: Response) -> dict[str, str]:
    with db_transaction() as connection:
        revoke_session(connection, request.cookies.get(SESSION_COOKIE))
    response.delete_cookie(key=SESSION_COOKIE, path="/", httponly=True, samesite="lax")
    return {"status": "signed_out"}


@app.get("/api/auth/session", response_model=SessionResponse)
def current_session(request: Request) -> SessionResponse:
    with db_transaction() as connection:
        return require_session(connection, request)


@app.get("/api/businesses", response_model=list[BusinessSummary])
def get_businesses(request: Request) -> list[BusinessSummary]:
    with db_transaction() as connection:
        session = require_session(connection, request)
        return list_businesses(connection, session.owner_id)


@app.post("/api/businesses", response_model=WorkspaceResponse, status_code=201)
def create_business(payload: AnalysisRequest, request: Request) -> WorkspaceResponse:
    with db_transaction() as connection:
        session = require_session(connection, request)
        try:
            business_id = save_business(connection, session.owner_id, payload)
        except InvalidFigureSourceError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        return load_workspace(connection, session.owner_id, business_id)


@app.put("/api/businesses/{business_id}", response_model=WorkspaceResponse)
def replace_business(
    business_id: UUID, payload: UpdateBusinessRequest, request: Request
) -> WorkspaceResponse:
    with db_transaction() as connection:
        session = require_session(connection, request)
        try:
            update_business(
                connection,
                session.owner_id,
                business_id,
                payload,
                payload.expected_revision,
            )
            return load_workspace(connection, session.owner_id, business_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None
        except InvalidFigureSourceError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None


@app.get("/api/businesses/{business_id}", response_model=WorkspaceResponse)
def get_business(business_id: UUID, request: Request) -> WorkspaceResponse:
    with db_transaction() as connection:
        session = require_session(connection, request)
        try:
            return load_workspace(connection, session.owner_id, business_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None


@app.post(
    "/api/businesses/{business_id}/analysis",
    response_model=WorkspaceResponse,
    status_code=201,
)
def create_business_analysis(business_id: UUID, request: Request) -> WorkspaceResponse:
    with db_transaction() as connection:
        session = require_session(connection, request)
        try:
            save_analysis(connection, session.owner_id, business_id)
            return load_workspace(connection, session.owner_id, business_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None


@app.get("/api/analysis-runs/{run_id}", response_model=AnalysisRunResponse)
def get_analysis_run(run_id: UUID, request: Request) -> AnalysisRunResponse:
    with db_transaction() as connection:
        session = require_session(connection, request)
        try:
            return load_analysis(connection, session.owner_id, run_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None


@app.get(
    "/api/businesses/{business_id}/documents",
    response_model=list[DocumentSummary],
)
def get_business_documents(
    business_id: UUID, request: Request
) -> list[DocumentSummary]:
    with db_transaction() as connection:
        session = require_session(connection, request)
        try:
            return list_documents(connection, session.owner_id, business_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None


@contextmanager
def document_errors():
    try:
        yield
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    except DocumentRejectError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        ) from None
    except (RuntimeError, SQLAlchemyError):
        raise HTTPException(
            status_code=503,
            detail="Document service unavailable; refresh document status before retrying.",
        ) from None


@app.post(
    "/api/businesses/{business_id}/documents",
    response_model=DocumentSummary,
    status_code=201,
)
def upload_business_document(
    business_id: UUID, request: Request, file: UploadFile = File(...)
) -> DocumentSummary:
    try:
        with db_transaction() as connection:
            session = require_session(connection, request)
        with document_errors():
            return upload_and_process_document(
                get_engine(),
                session.owner_id,
                business_id,
                file.filename,
                file.content_type,
                file.file,
            )
    finally:
        file.file.close()


@app.post(
    "/api/businesses/{business_id}/documents/{document_id}/retry",
    response_model=DocumentSummary,
)
def retry_business_document(
    business_id: UUID, document_id: UUID, request: Request
) -> DocumentSummary:
    with db_transaction() as connection:
        session = require_session(connection, request)
    with document_errors():
        return retry_document_processing(
            get_engine(), session.owner_id, business_id, document_id
        )


@app.get(
    "/api/businesses/{business_id}/documents/{document_id}/extraction",
    response_model=DocumentExtractionResponse,
)
def read_business_document_extraction(
    business_id: UUID, document_id: UUID, request: Request
) -> DocumentExtractionResponse:
    with db_transaction() as connection:
        session = require_session(connection, request)
        with document_errors():
            return get_document_extraction(
                connection, session.owner_id, business_id, document_id
            )


@app.post(
    "/api/businesses/{business_id}/documents/{document_id}/extract",
    response_model=DocumentExtractionResponse,
)
@app.post(
    "/api/businesses/{business_id}/documents/{document_id}/extraction",
    response_model=DocumentExtractionResponse,
)
def extract_ready_business_document(
    business_id: UUID, document_id: UUID, request: Request
) -> DocumentExtractionResponse:
    with db_transaction() as connection:
        session = require_session(connection, request)
    with document_errors():
        return extract_ready_document(
            get_engine(), session.owner_id, business_id, document_id
        )


@app.get("/api/businesses/{business_id}/documents/{document_id}/file")
def download_business_document(
    business_id: UUID, document_id: UUID, request: Request
) -> FileResponse:
    with db_transaction() as connection:
        session = require_session(connection, request)
        try:
            doc, path = get_document_file(
                connection, session.owner_id, business_id, document_id
            )
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
    safe_ascii = (
        doc.filename.encode("ascii", "replace").decode("ascii").replace('"', "_")
    )
    encoded = quote(doc.filename)
    return FileResponse(
        path=path,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"inline; filename=\"{safe_ascii}\"; filename*=UTF-8''{encoded}",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        },
    )


@app.delete("/api/businesses/{business_id}/documents/{document_id}")
def remove_business_document(
    business_id: UUID, document_id: UUID, request: Request
) -> dict[str, str]:
    with db_transaction() as connection:
        session = require_session(connection, request)
    with document_errors():
        delete_document(get_engine(), session.owner_id, business_id, document_id)
    return {"status": "deleted"}


@app.post(
    "/api/businesses/{business_id}/retrieval",
    response_model=RetrievalResponse,
)
def search_business_passages(
    business_id: UUID, payload: RetrievalRequest, request: Request
) -> RetrievalResponse:
    with db_transaction() as connection:
        session = require_session(connection, request)
        try:
            return retrieve_passages(
                connection,
                session.owner_id,
                business_id,
                payload.query,
                top_k=payload.top_k,
                year_start=payload.year_start,
                document_id=payload.document_id,
            )
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
        except EmbeddingUnavailableError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None


@app.post(
    "/api/businesses/{business_id}/qa",
    response_model=QAResponse,
)
def ask_business_question(
    business_id: UUID, payload: QARequest, request: Request
) -> QAResponse:
    # Close DB transaction before local LLM inference so connections are never held idle.
    with db_transaction() as connection:
        session = require_session(connection, request)
        try:
            context = load_qa_context(
                connection,
                session.owner_id,
                business_id,
                payload.question,
                top_k=payload.top_k,
                year_start=payload.year_start,
                document_id=payload.document_id,
            )
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
    return answer_workspace_question(
        context, payload.question, year_start=payload.year_start
    )
