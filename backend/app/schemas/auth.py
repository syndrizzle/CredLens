import re
from typing import Annotated
from uuid import UUID

from pydantic import StringConstraints, field_validator

from app.schemas.base import Model


class CredentialsRequest(Model):
    email: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True, to_lower=True, min_length=3, max_length=254
        ),
    ]
    password: Annotated[str, StringConstraints(min_length=12, max_length=128)]

    @field_validator("email")
    @classmethod
    def check_email(cls, value: str) -> str:
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
            raise ValueError("Enter a valid email address")
        return value


class SessionResponse(Model):
    owner_id: UUID
    email: str
