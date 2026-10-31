"""Account lookups. Parameterised queries, validated input, explicit errors."""
import logging
import sqlite3

log = logging.getLogger(__name__)
MAX_ID = 2**31 - 1


class NotFound(Exception):
    pass


def find_account(db: sqlite3.Connection, account_id: int) -> dict:
    if not isinstance(account_id, int) or not 0 < account_id <= MAX_ID:
        raise ValueError("account_id out of range")
    row = db.execute("SELECT id, name FROM accounts WHERE id = ?", (account_id,)).fetchone()
    if row is None:
        log.info("account not found", extra={"account_id": account_id})
        raise NotFound(account_id)
    return {"id": row[0], "name": row[1]}
