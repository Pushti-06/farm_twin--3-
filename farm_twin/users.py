"""
Multi-user registration and per-user alert notification (e-mail now, Telegram, SMS later).

  users.register(app)               -> adds /register /login /logout /account /unsubscribe/<token>
  users.notify_subscribers(rec)     -> called from alerts.notify() for every NEW warning/critical alert

Storage: one SQLite file (env USERS_DB, default data/users.db). Secrets only from environment variables:
  SECRET_KEY, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, ALERT_EMAIL_FROM, TELEGRAM_BOT_TOKEN,
  PUBLIC_URL (used in the unsubscribe link, default http://127.0.0.1:5000)
"""
import os
import secrets
import smtplib
import sqlite3
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import requests
from flask import Blueprint, abort, redirect, render_template_string, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from tn_districts import TN_DISTRICTS

DB_PATH = os.environ.get("USERS_DB", os.path.join("data", "users.db"))
LEVELS = ["none", "watch", "warning", "critical"]
CHANNELS = ["email", "telegram", "sms"]
DEDUPE_HOURS = 24
bp = Blueprint("users", __name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT,
  pw_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'farmer', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subscriptions(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  district TEXT NOT NULL, crop TEXT, channel TEXT NOT NULL, min_level TEXT NOT NULL DEFAULT 'warning',
  telegram_chat TEXT, active INTEGER NOT NULL DEFAULT 1, unsub_token TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY, sub_id INTEGER NOT NULL, user_id INTEGER NOT NULL, signature TEXT NOT NULL,
  channel TEXT NOT NULL, status TEXT NOT NULL, error TEXT, sent_at TEXT NOT NULL);
"""


def db():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.executescript(SCHEMA)
    return con


# ------------------------------------------------------------------ senders (each returns None or raises)
def send_email(to, subject, text):
    host = os.environ.get("SMTP_HOST")
    if not host:
        raise RuntimeError("SMTP_HOST not set")
    msg = EmailMessage()
    msg["Subject"], msg["To"] = subject, to
    msg["From"] = os.environ.get("ALERT_EMAIL_FROM", os.environ.get("SMTP_USER", "twin@localhost"))
    msg.set_content(text)
    with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", "587")), timeout=15) as s:
        if os.environ.get("SMTP_STARTTLS", "1") == "1":
            s.starttls()
        if os.environ.get("SMTP_USER"):
            s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
        s.send_message(msg)


def send_telegram(chat_id, subject, text):
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token or not chat_id:
        raise RuntimeError("TELEGRAM_BOT_TOKEN or chat id missing")
    r = requests.post(f"https://api.telegram.org/bot{token}/sendMessage", json={"chat_id": chat_id, "text": text}, timeout=10)
    r.raise_for_status()


def send_sms(phone, subject, text):
    # Slot for a provider (Twilio, MSG91, Fast2SMS...). Needs a provider account and, in India, DLT
    # registration of the sender id and message template. Until configured it reports itself as skipped.
    raise NotImplementedError("SMS provider not configured")


SENDERS = {"email": send_email, "telegram": send_telegram, "sms": send_sms}


# ------------------------------------------------------------------ fan-out
def _text(rec, unsub_url):
    ev = "; ".join(f"{e['indicator']}: {e['value']}" for e in rec.get("evidence", []) if e.get("points"))
    return (f"[{rec['level'].upper()}] {rec['district'].title()} ({rec.get('crop') or 'all crops'}): {ev}. "
            f"Please verify in the field.\nStop these alerts: {unsub_url}")


def notify_subscribers(rec, con=None):
    """Sends one alert record to every matching, active subscription. Never raises."""
    if rec.get("level") not in ("warning", "critical"):
        return 0
    own = con is None
    try:
        con = con or db()
        base = os.environ.get("PUBLIC_URL", "http://127.0.0.1:5000").rstrip("/")
        rank = LEVELS.index(rec["level"])
        rows = con.execute(
            "SELECT s.*, u.email, u.phone FROM subscriptions s JOIN users u ON u.id=s.user_id "
            "WHERE s.active=1 AND s.district=? AND (s.crop IS NULL OR s.crop='' OR UPPER(s.crop)=UPPER(?))",
            (rec["district"].upper(), rec.get("crop") or "")).fetchall()
        sent = 0
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=DEDUPE_HOURS)).isoformat(timespec="seconds")
        for s in rows:
            if LEVELS.index(s["min_level"]) > rank:
                continue
            if con.execute("SELECT 1 FROM notifications WHERE sub_id=? AND signature=? AND status='sent' AND sent_at>?",
                           (s["id"], rec["signature"], cutoff)).fetchone():
                continue
            target = {"email": s["email"], "telegram": s["telegram_chat"], "sms": s["phone"]}[s["channel"]]
            status, err = "sent", None
            try:
                SENDERS[s["channel"]](target, f"Crop alert {rec['level']}: {rec['district'].title()}",
                                      _text(rec, f"{base}/unsubscribe/{s['unsub_token']}"))
                sent += 1
            except NotImplementedError as e:
                status, err = "skipped", str(e)
            except Exception as e:  # one failing user or channel must not stop the others
                status, err = "failed", str(e)[:200]
            con.execute("INSERT INTO notifications(sub_id,user_id,signature,channel,status,error,sent_at) VALUES(?,?,?,?,?,?,?)",
                        (s["id"], s["user_id"], rec["signature"], s["channel"], status, err,
                         datetime.now(timezone.utc).isoformat(timespec="seconds")))
        con.commit()
        return sent
    except Exception:
        return 0
    finally:
        if own and con is not None:
            con.close()


# ------------------------------------------------------------------ web pages
PAGE = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>{{ title }}</title><style>body{font:15px system-ui;max-width:560px;margin:30px auto;padding:0 16px;color:#1d2b24}
input,select,button{font:inherit;padding:8px;margin:4px 0;width:100%;box-sizing:border-box}button{background:#2f8f5b;color:#fff;border:0;border-radius:6px;cursor:pointer}
.err{color:#b3261e}.ok{color:#1d6a43}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}a{color:#2f6f8f}</style>
<h2>{{ title }}</h2>{% if msg %}<p class="{{ cls }}">{{ msg }}</p>{% endif %}{{ body|safe }}
<p><a href="/">Dashboard</a> · <a href="/account">My alerts</a> · <a href="/login">Login</a> · <a href="/register">Register</a></p>"""


def page(title, body, msg="", cls="err"):
    return render_template_string(PAGE, title=title, body=body, msg=msg, cls=cls)


def _csrf():
    session.setdefault("csrf", secrets.token_hex(16))
    return f'<input type=hidden name=csrf value="{session["csrf"]}">'


def _check_csrf():
    if request.form.get("csrf") != session.get("csrf"):
        abort(400)


def _opts(items, sel=""):
    return "".join(f'<option value="{i}"{" selected" if i == sel else ""}>{i.title() if i.isupper() else i}</option>' for i in items)


@bp.route("/register", methods=["GET", "POST"])
def register_page():
    msg = ""
    if request.method == "POST":
        _check_csrf()
        f = request.form
        name, email, pw = f.get("name", "").strip(), f.get("email", "").strip().lower(), f.get("password", "")
        if not name or "@" not in email or len(pw) < 8:
            msg = "Enter a name, a valid e-mail and a password of at least 8 characters."
        else:
            con = db()
            try:
                con.execute("INSERT INTO users(name,email,phone,pw_hash,created_at) VALUES(?,?,?,?,?)",
                            (name, email, f.get("phone", "").strip(), generate_password_hash(pw),
                             datetime.now(timezone.utc).isoformat(timespec="seconds")))
                con.commit()
                session["uid"] = con.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()["id"]
                return redirect(url_for("users.account"))
            except sqlite3.IntegrityError:
                msg = "That e-mail is already registered."
            finally:
                con.close()
    body = f'<form method=post>{_csrf()}Name<input name=name required>E-mail<input name=email type=email required>' \
           f'Phone (optional, for SMS later)<input name=phone>Password (8+ characters)<input name=password type=password required>' \
           f'<button>Create account</button></form>'
    return page("Register", body, msg)


@bp.route("/login", methods=["GET", "POST"])
def login():
    msg = ""
    if request.method == "POST":
        _check_csrf()
        con = db()
        u = con.execute("SELECT * FROM users WHERE email=?", (request.form.get("email", "").strip().lower(),)).fetchone()
        con.close()
        if u and check_password_hash(u["pw_hash"], request.form.get("password", "")):
            session["uid"] = u["id"]
            return redirect(url_for("users.account"))
        msg = "Wrong e-mail or password."
    body = f'<form method=post>{_csrf()}E-mail<input name=email type=email required>Password<input name=password type=password required><button>Login</button></form>'
    return page("Login", body, msg)


@bp.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("users.login"))


def send_test(con, uid):
    """Sends a clearly labelled TEST alert to the signed-in user's own subscriptions (nobody else's)."""
    subs = con.execute("SELECT s.*, u.email, u.phone FROM subscriptions s JOIN users u ON u.id=s.user_id "
                       "WHERE s.user_id=? AND s.active=1", (uid,)).fetchall()
    if not subs:
        return "Add a subscription first, then send a test.", "err"
    base = os.environ.get("PUBLIC_URL", "http://127.0.0.1:5000").rstrip("/")
    ok, bad = 0, []
    for s in subs:
        rec = {"level": "critical", "district": s["district"], "crop": s["crop"],
               "evidence": [{"indicator": "TEST MESSAGE - not a real alert", "value": "delivery check", "points": 1}]}
        target = {"email": s["email"], "telegram": s["telegram_chat"], "sms": s["phone"]}[s["channel"]]
        status, err = "sent", None
        try:
            SENDERS[s["channel"]](target, f"TEST crop alert: {s['district'].title()}",
                                  "THIS IS A TEST. " + _text(rec, f"{base}/unsubscribe/{s['unsub_token']}"))
            ok += 1
        except NotImplementedError as e:
            status, err = "skipped", str(e)
        except Exception as e:
            status, err = "failed", str(e)[:200]
        if status != "sent":
            bad.append(f"{s['channel']}: {err}")
        con.execute("INSERT INTO notifications(sub_id,user_id,signature,channel,status,error,sent_at) VALUES(?,?,?,?,?,?,?)",
                    (s["id"], uid, "test-" + secrets.token_hex(4), s["channel"], status, err,
                     datetime.now(timezone.utc).isoformat(timespec="seconds")))
    con.commit()
    if bad:
        return f"Test: {ok} sent, {len(bad)} not sent ({'; '.join(bad)})", "err"
    return f"Test message sent for {ok} subscription(s). Check your inbox (and spam).", "ok"


@bp.route("/account", methods=["GET", "POST"])
def account():
    uid = session.get("uid")
    if not uid:
        return redirect(url_for("users.login"))
    con = db()
    msg, cls = "", "ok"
    if request.method == "POST":
        _check_csrf()
        f = request.form
        if f.get("action") == "add":
            district, channel, level = f.get("district", ""), f.get("channel", ""), f.get("min_level", "warning")
            if district not in TN_DISTRICTS or channel not in CHANNELS or level not in ("warning", "critical"):
                msg, cls = "Choose a valid district, channel and level.", "err"
            else:
                con.execute("INSERT INTO subscriptions(user_id,district,crop,channel,min_level,telegram_chat,unsub_token) VALUES(?,?,?,?,?,?,?)",
                            (uid, district, f.get("crop", "").strip().upper() or None, channel, level,
                             f.get("telegram_chat", "").strip() or None, secrets.token_urlsafe(24)))
                con.commit(); msg = "Subscription added."
        elif f.get("action") == "test":
            msg, cls = send_test(con, uid)
        elif f.get("action") == "remove":
            con.execute("DELETE FROM subscriptions WHERE id=? AND user_id=?", (f.get("id"), uid)); con.commit(); msg = "Removed."
    u = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    subs = con.execute("SELECT * FROM subscriptions WHERE user_id=?", (uid,)).fetchall()
    logs = con.execute("SELECT n.sent_at,n.channel,n.status,n.error FROM notifications n WHERE n.user_id=? ORDER BY n.id DESC LIMIT 10", (uid,)).fetchall()
    con.close()
    rows = "".join(f"<tr><td>{s['district'].title()}</td><td>{s['crop'] or 'all'}</td><td>{s['channel']}</td><td>{s['min_level']}</td>"
                   f"<td><form method=post>{_csrf()}<input type=hidden name=action value=remove><input type=hidden name=id value={s['id']}><button>Remove</button></form></td></tr>" for s in subs)
    hist = "".join(f"<tr><td>{l['sent_at']}</td><td>{l['channel']}</td><td>{l['status']}</td><td>{l['error'] or ''}</td></tr>" for l in logs)
    body = (f"<p>Signed in as <b>{u['name']}</b> ({u['email']}) · <a href='/logout'>Logout</a></p><h3>My alert subscriptions</h3>"
            f"<table><tr><th>District</th><th>Crop</th><th>Channel</th><th>From level</th><th></th></tr>{rows}</table>"
            f"<h3>Add a subscription</h3><form method=post>{_csrf()}<input type=hidden name=action value=add>"
            f"District<select name=district>{_opts(sorted(TN_DISTRICTS))}</select>Crop (blank = all)<input name=crop placeholder='RICE'>"
            f"Channel<select name=channel>{_opts(CHANNELS)}</select>Send from level<select name=min_level>{_opts(['warning','critical'])}</select>"
            f"Telegram chat id (only for Telegram)<input name=telegram_chat><button>Add</button></form>"
            f"<form method=post>{_csrf()}<input type=hidden name=action value=test><button>Send me a test alert now</button></form>"
            f"<h3>Recent messages</h3><table><tr><th>Time</th><th>Channel</th><th>Status</th><th>Note</th></tr>{hist}</table>")
    return page("My alerts", body, msg, cls)


@bp.route("/unsubscribe/<token>")
def unsubscribe(token):
    con = db()
    cur = con.execute("UPDATE subscriptions SET active=0 WHERE unsub_token=?", (token,))
    con.commit(); con.close()
    return page("Unsubscribed", "<p>You will not receive these alerts any more.</p>") if cur.rowcount else abort(404)


def register(app):
    app.secret_key = os.environ.get("SECRET_KEY") or app.secret_key or secrets.token_hex(32)
    app.register_blueprint(bp)