"""Subscription plans. Prices are per 30 days, paid in SOL to the treasury wallet."""
from .database import now

PLAN_DAYS = 30

PLANS: dict[str, dict] = {
    "free": {
        "id": "free", "name": "Scout", "price_usd": 0, "rank": 0,
        "fee_bps": 100, "daily_buys": 5, "max_positions": 3,
        "auto_snipe": False, "tp_sl": False, "trailing": False, "copy_wallets": 0, "priority_fees": False,
        "tagline": "Learn the terminal with manual trades.",
        "features": ["Live token discovery feed", "Rug-risk safety score", "Manual buy & sell",
                     "5 buys per day, 3 open positions", "1% fee per trade"],
    },
    "pro": {
        "id": "pro", "name": "Hunter", "price_usd": 100, "rank": 1,
        "fee_bps": 75, "daily_buys": None, "max_positions": 15,
        "auto_snipe": True, "tp_sl": True, "trailing": False, "copy_wallets": 2, "priority_fees": False,
        "tagline": "Automation for active traders.",
        "features": ["Everything in Scout", "Auto-sniper with safety filters", "Take-profit & stop-loss",
                     "Copy 2 wallets", "Unlimited buys, 15 open positions", "0.75% fee per trade"],
    },
    "elite": {
        "id": "elite", "name": "Apex", "price_usd": 500, "rank": 2,
        "fee_bps": 50, "daily_buys": None, "max_positions": 50,
        "auto_snipe": True, "tp_sl": True, "trailing": True, "copy_wallets": 10, "priority_fees": True,
        "tagline": "Speed and control for serious size.",
        "features": ["Everything in Hunter", "Trailing stop-loss", "Custom priority fees",
                     "Copy 10 wallets", "50 open positions", "0.5% fee per trade"],
    },
    "whale": {
        "id": "whale", "name": "Leviathan", "price_usd": 1000, "rank": 3,
        "fee_bps": 25, "daily_buys": None, "max_positions": 200,
        "auto_snipe": True, "tp_sl": True, "trailing": True, "copy_wallets": 30, "priority_fees": True,
        "tagline": "Lowest fees, highest limits.",
        "features": ["Everything in Apex", "Copy 30 wallets", "200 open positions",
                     "0.25% fee per trade", "Priority support"],
    },
}


def effective_plan_id(user) -> str:
    if user.plan != "free" and user.plan_expires_at and user.plan_expires_at > now():
        return user.plan
    return "free"


def plan_of(user) -> dict:
    return PLANS[effective_plan_id(user)]


def fee_bps_for(user) -> int:
    if user.fee_free_until and user.fee_free_until > now():
        return 0
    return plan_of(user)["fee_bps"]
