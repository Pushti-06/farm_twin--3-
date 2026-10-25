import importlib
import pytest


@pytest.fixture
def U(tmp_path, monkeypatch):
    monkeypatch.setenv("USERS_DB", str(tmp_path / "u.db"))
    import users
    importlib.reload(users)
    sent = []
    monkeypatch.setitem(users.SENDERS, "email", lambda to, subj, text: sent.append((to, subj, text)))
    users.sent = sent
    return users


def add(U, email, district="VELLORE", crop=None, channel="email", level="warning"):
    con = U.db()
    con.execute("INSERT OR IGNORE INTO users(id,name,email,pw_hash,created_at) VALUES(?,?,?,?,?)",
                (abs(hash(email)) % 10**6, email, email, "x", "t"))
    uid = con.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()["id"]
    con.execute("INSERT INTO subscriptions(user_id,district,crop,channel,min_level,unsub_token) VALUES(?,?,?,?,?,?)",
                (uid, district, crop, channel, level, email + district + str(level) + str(channel)))
    con.commit(); con.close()


def rec(level="warning", district="VELLORE", crop="RICE", sig="s1"):
    return {"level": level, "district": district, "crop": crop, "signature": sig,
            "evidence": [{"indicator": "NDVI vs normal", "value": "-14%", "points": 2}]}


def test_only_matching_district_and_level(U):
    add(U, "a@x.in"); add(U, "b@x.in", district="SALEM"); add(U, "c@x.in", level="critical")
    assert U.notify_subscribers(rec("warning")) == 1
    assert [s[0] for s in U.sent] == ["a@x.in"]
    U.notify_subscribers(rec("critical", sig="s2"))
    assert sorted(s[0] for s in U.sent) == ["a@x.in", "a@x.in", "c@x.in"]


def test_crop_filter(U):
    add(U, "a@x.in", crop="RICE"); add(U, "b@x.in", crop="BANANA")
    U.notify_subscribers(rec(crop="RICE"))
    assert [s[0] for s in U.sent] == ["a@x.in"]


def test_not_sent_twice_and_failure_isolated(U, monkeypatch):
    add(U, "a@x.in"); add(U, "b@x.in")
    calls = []
    def flaky(to, subj, text):
        calls.append(to)
        if to == "a@x.in": raise OSError("smtp down")
    monkeypatch.setitem(U.SENDERS, "email", flaky)
    U.notify_subscribers(rec()); assert "b@x.in" in calls
    U.notify_subscribers(rec())           # b already sent -> not again; a failed -> retried
    assert calls.count("b@x.in") == 1 and calls.count("a@x.in") == 2


def test_watch_level_never_sent_and_sms_skipped(U):
    add(U, "a@x.in"); assert U.notify_subscribers(rec("watch")) == 0
    add(U, "s@x.in", channel="sms"); U.notify_subscribers(rec(sig="n"))
    con = U.db(); st = con.execute("SELECT status FROM notifications WHERE channel='sms'").fetchone()["status"]
    assert st == "skipped"


def test_web_flow(U):
    from flask import Flask
    app = Flask(__name__); app.config["TESTING"] = True; U.register(app); c = app.test_client()
    def token(path):
        import re
        return re.search(r'name=csrf value="(\w+)"', c.get(path).get_data(as_text=True)).group(1)
    r = c.post("/register", data={"csrf": token("/register"), "name": "A", "email": "A@X.in", "password": "longenough1"})
    assert r.status_code == 302
    r = c.post("/account", data={"csrf": token("/account"), "action": "add", "district": "VELLORE", "channel": "email", "min_level": "warning"})
    assert "Vellore" in r.get_data(as_text=True)
    assert c.post("/register", data={"csrf": "bad"}).status_code == 400
    U.notify_subscribers(rec())
    assert U.sent and U.sent[0][0] == "a@x.in"
    tok = U.db().execute("SELECT unsub_token FROM subscriptions").fetchone()[0]
    assert c.get("/unsubscribe/" + tok).status_code == 200
    U.sent.clear(); U.notify_subscribers(rec(sig="other")); assert U.sent == []


def test_send_test_button(U):
    from flask import Flask
    import re
    app = Flask(__name__); app.config["TESTING"] = True; U.register(app); c = app.test_client()
    tok = lambda p: re.search(r'name=csrf value="(\w+)"', c.get(p).get_data(as_text=True)).group(1)
    c.post("/register", data={"csrf": tok("/register"), "name": "A", "email": "a@x.in", "password": "longenough1"})
    r = c.post("/account", data={"csrf": tok("/account"), "action": "test"})
    assert "Add a subscription first" in r.get_data(as_text=True)
    c.post("/account", data={"csrf": tok("/account"), "action": "add", "district": "VELLORE", "channel": "email", "min_level": "warning"})
    r = c.post("/account", data={"csrf": tok("/account"), "action": "test"})
    assert "Test message sent" in r.get_data(as_text=True)
    assert U.sent and U.sent[0][1].startswith("TEST") and "THIS IS A TEST" in U.sent[0][2]