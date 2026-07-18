"""Auth0 JWT validation (RFC §6).

There is NO session-creation endpoint. Every request carries an Auth0-issued
JWT (RS256, validated against the tenant's JWKS); the `sub` claim is used as
`user_id` everywhere in the data model.
"""
from functools import lru_cache

import jwt
from fastapi import Depends, HTTPException, Query, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import config

_bearer = HTTPBearer(auto_error=False)


@lru_cache(maxsize=1)
def _jwks_client() -> jwt.PyJWKClient:
    if not config.AUTH0_DOMAIN:
        raise RuntimeError("AUTH0_DOMAIN is not configured (see .env.example)")
    return jwt.PyJWKClient(f"https://{config.AUTH0_DOMAIN}/.well-known/jwks.json")


def decode_token(token: str) -> dict:
    try:
        signing_key = _jwks_client().get_signing_key_from_jwt(token).key
        return jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            audience=config.AUTH0_AUDIENCE,
            issuer=f"https://{config.AUTH0_DOMAIN}/",
            leeway=120,  # absorb clock skew between this machine and Auth0 (iat/nbf/exp)
        )
    except Exception as exc:  # noqa: BLE001 - map every failure to 401
        raise HTTPException(status_code=401, detail=f"invalid token: {exc}") from exc


async def current_user_id(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str:
    """FastAPI dependency: validated Auth0 `sub` claim."""
    if creds is None:
        raise HTTPException(status_code=401, detail="missing bearer token")
    claims = decode_token(creds.credentials)
    return claims["sub"]


async def raw_access_token(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str:
    """The raw (validated) Auth0 access token -- needed as the subject token
    for the Token Vault exchange in /playlist/export."""
    if creds is None:
        raise HTTPException(status_code=401, detail="missing bearer token")
    decode_token(creds.credentials)
    return creds.credentials


async def user_id_header_or_query(
    request: Request,
    token: str | None = Query(default=None),
) -> str:
    """Auth for the audio-streaming endpoint only: HTML <audio> elements cannot
    set headers, so a `?token=` query parameter is also accepted there."""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return decode_token(auth[7:])["sub"]
    if token:
        return decode_token(token)["sub"]
    raise HTTPException(status_code=401, detail="missing bearer token")
