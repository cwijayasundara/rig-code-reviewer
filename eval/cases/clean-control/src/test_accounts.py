import sqlite3
import pytest
from accounts import NotFound, find_account


def db():
    c = sqlite3.connect(":memory:")
    c.execute("CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT)")
    c.execute("INSERT INTO accounts VALUES (1, 'ada')")
    return c


def test_found():
    assert find_account(db(), 1) == {"id": 1, "name": "ada"}


def test_missing():
    with pytest.raises(NotFound):
        find_account(db(), 2)


def test_range():
    with pytest.raises(ValueError):
        find_account(db(), 0)
