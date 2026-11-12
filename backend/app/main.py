from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from sqlalchemy.exc import SQLAlchemyError

from app.database import check_database
from app.analysis import analyse
from app.schemas import AnalysisRequest, AnalysisResponse

app = FastAPI(title="CredLens", version="0.1.0")


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
