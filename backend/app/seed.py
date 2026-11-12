"""Load the labelled fictional fixture once; never creates a login account."""
import json
from pathlib import Path
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app.database import get_engine
from app.models import owners, businesses
from app.persistence import save_business, save_analysis
from app.schemas import AnalysisRequest

DEMO_OWNER = UUID("fb1b5dcf-28c7-4c8c-98bf-652594eb87ed")


def seed_fixture():
    payload = json.loads((Path(__file__).resolve().parents[1] / "tests/fixtures/aster_components.json").read_text())["request"]
    request = AnalysisRequest.model_validate(payload)
    with get_engine().begin() as connection:
        connection.execute(insert(owners).values(id=DEMO_OWNER).on_conflict_do_nothing())
        connection.execute(select(owners).where(owners.c.id == DEMO_OWNER).with_for_update())
        existing = connection.execute(select(businesses.c.id).where(
            businesses.c.owner_id == DEMO_OWNER, businesses.c.name == request.business_name)).scalar_one_or_none()
        if existing is not None:
            return existing
        business_id = save_business(connection, DEMO_OWNER, request)
        save_analysis(connection, DEMO_OWNER, business_id)
        return business_id


if __name__ == "__main__":
    print(f"Fictional fixture available: {seed_fixture()}")
