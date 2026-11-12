from contextlib import contextmanager
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from app.analysis import analyse
from app.auth import SESSION_COOKIE, SESSION_MAX_AGE, authenticate_account, register_account, resolve_session, revoke_session
from app.database import check_database, get_engine
from app.persistence import list_businesses, load_analysis, load_workspace, save_analysis, save_business
from app.schemas import AnalysisRequest, AnalysisResponse, BusinessSummary, CredentialsRequest, SessionResponse, WorkspaceResponse

app = FastAPI(title="CredLens", version="0.1.0")


@contextmanager
def db_transaction():
    try:
        with get_engine().begin() as connection:
            yield connection
    except (RuntimeError, SQLAlchemyError):
        raise HTTPException(status_code=503, detail="Database unavailable") from None


def set_session_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE, value=token, max_age=SESSION_MAX_AGE,
        httponly=True, samesite="lax", secure=request.url.scheme == "https", path="/",
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
def register(payload: CredentialsRequest, request: Request, response: Response) -> SessionResponse:
    with db_transaction() as connection:
        try:
            session, token = register_account(connection, payload.email, payload.password)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None
    set_session_cookie(response, request, token)
    return session


@app.post("/api/auth/login", response_model=SessionResponse)
def login(payload: CredentialsRequest, request: Request, response: Response) -> SessionResponse:
    with db_transaction() as connection:
        try:
            session, token = authenticate_account(connection, payload.email, payload.password)
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
        business_id = save_business(connection, session.owner_id, payload)
        return load_workspace(connection, session.owner_id, business_id)


@app.get("/api/businesses/{business_id}", response_model=WorkspaceResponse)
def get_business(business_id: UUID, request: Request) -> WorkspaceResponse:
    with db_transaction() as connection:
        session = require_session(connection, request)
        try:
            return load_workspace(connection, session.owner_id, business_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None


@app.post("/api/businesses/{business_id}/analysis", response_model=WorkspaceResponse, status_code=201)
def create_business_analysis(business_id: UUID, request: Request) -> WorkspaceResponse:
    with db_transaction() as connection:
        session = require_session(connection, request)
        try:
            save_analysis(connection, session.owner_id, business_id)
            return load_workspace(connection, session.owner_id, business_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None


@app.get("/api/analysis-runs/{run_id}", response_model=AnalysisResponse)
def get_analysis_run(run_id: UUID, request: Request) -> AnalysisResponse:
    with db_transaction() as connection:
        session = require_session(connection, request)
        try:
            return load_analysis(connection, session.owner_id, run_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
