# llmnav/1 module
# id=example.privacy.export
# role=Own preparation and expiry of user data export jobs.
# owns=export manifest|temporary export object
# excludes=account deletion|long-term archive storage
# search=privacy export lifecycle|temporary archive|export expiry
# invariant=Every export object expires after the configured retention window.
# stability=architecture
# /llmnav

from dataclasses import dataclass


@dataclass(frozen=True)
class ExportJob:
    job_id: str
    object_key: str


# llmnav/1 symbol
# id=example.privacy.export.prepare
# role=Create one auditable export job without exposing its object key publicly.
# search=data export|privacy download|export preparation
# invariant=Only the requesting account can resolve the private object key.
# effect=db.write(export_jobs)|event.emit(privacy.export.requested)
# risk=privacy
# rel=test>example.privacy.export.prepare-contract
# stability=contract
# /llmnav

def prepare_export(account_id: str) -> ExportJob:
    return ExportJob(job_id=f"job:{account_id}", object_key=f"private/{account_id}")


# llmnav/1 symbol
# id=example.privacy.export.prepare-contract
# role=Verify export preparation keeps object keys private and jobs auditable.
# search=export contract|private object key|export audit
# stability=contract
# /llmnav

def assert_prepare_export_contract() -> None:
    """Replace with repository-specific tests."""
