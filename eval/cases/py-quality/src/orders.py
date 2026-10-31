import requests


def load_orders(db, customer_ids):
    out = []
    for cid in customer_ids:
        out.extend(db.query("SELECT * FROM orders WHERE customer_id = %s", (cid,)))
    return out


def notify(order):
    try:
        requests.post("https://hooks.example.com/orders", json=order)
    except Exception:
        pass
