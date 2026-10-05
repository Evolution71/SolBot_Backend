"""Application settings. Every value can be overridden with an environment variable."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_JWT_SECRET = "dev-only-secret-change-me-before-going-live"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "Nexus Sol Bot"
    database_url: str = "sqlite:///./nexus.db"
    cors_origins: str = "http://localhost:5173"
    frontend_url: str = "http://localhost:5173"

    # --- security ---
    jwt_secret: str = DEFAULT_JWT_SECRET
    jwt_expire_minutes: int = 60 * 24 * 7
    # Fernet key used to encrypt users' trading-wallet secret keys at rest.
    # Generate: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    wallet_encryption_key: str = ""
    admin_email: str = ""  # the account registered with this email becomes admin

    # --- solana ---
    treasury_wallet: str = "469rxFHREhqpKcDBugswHFzvuCpuqzWhcSyWfvY8TrL3"
    solana_rpc_url: str = "https://api.mainnet-beta.solana.com"
    jupiter_api_url: str = "https://api.jup.ag/swap/v2"
    jupiter_api_key: str = ""  # free key from https://developers.jup.ag/portal - required for live trading

    # --- trading mode ---
    # True  = simulated balances and fills (safe for testing, no funds move)
    # False = real swaps on mainnet through Jupiter
    paper_trading: bool = True
    paper_start_sol: float = 10.0

    # --- background engine (auto-sniper, TP/SL monitor, copy trading) ---
    engine_enabled: bool = True
    engine_interval: float = 6.0

    # --- growth ---
    referral_share: float = 0.20      # share of a referee's trading fees paid to the referrer
    referral_unlock_count: int = 3    # active referrals needed for a free Pro month
    launch_promo_users: int = 500     # first N users trade with 0% fees...
    launch_promo_days: int = 7        # ...for this many days

    @property
    def db_url(self) -> str:
        url = self.database_url
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql+psycopg2://", 1)
        elif url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+psycopg2://", 1)
        return url

    def assert_production_ready(self) -> None:
        """Refuse to run live trading with development secrets."""
        if self.paper_trading:
            return
        problems = []
        if self.jwt_secret == DEFAULT_JWT_SECRET or len(self.jwt_secret) < 32:
            problems.append("JWT_SECRET must be a random string of 32+ characters")
        if not self.wallet_encryption_key:
            problems.append("WALLET_ENCRYPTION_KEY must be set")
        if not self.jupiter_api_key:
            problems.append("JUPITER_API_KEY must be set")
        if problems:
            raise RuntimeError("Live trading is blocked: " + "; ".join(problems))


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
