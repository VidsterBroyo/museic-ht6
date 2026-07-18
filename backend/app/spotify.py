"""Spotify, write-only (RFC §3/§6).

There is deliberately NO Spotify OAuth flow here. Auth0 Token Vault owns the
Spotify OAuth exchange and refresh: the Spotify Developer app's redirect URI
points at the Auth0 domain, and at export time this backend performs an
*access-token exchange* -- swapping the caller's Auth0 access token for a
Spotify-scoped access token -- then uses only:

  GET  /v1/search        (capped at 10 results/call in Development Mode)
  POST /v1/users/{id}/playlists
  POST /v1/playlists/{id}/tracks

Spotify's audio-features/analysis endpoints are dead for new apps and are not
used anywhere in this codebase.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import HTTPException

from . import config

log = logging.getLogger("museic.spotify")

SPOTIFY_API = "https://api.spotify.com/v1"
TOKEN_EXCHANGE_GRANT = (
    "urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token"
)


def spotify_token_from_vault(auth0_access_token: str) -> str:
    """Exchange the user's Auth0 access token for a Spotify access token via
    Auth0 Token Vault (access-token exchange, Custom API Client credentials)."""
    if not (config.AUTH0_TOKEN_VAULT_CLIENT_ID and config.AUTH0_TOKEN_VAULT_CLIENT_SECRET):
        raise HTTPException(
            status_code=501,
            detail=(
                "Token Vault is not configured. Set AUTH0_TOKEN_VAULT_CLIENT_ID / "
                "AUTH0_TOKEN_VAULT_CLIENT_SECRET (see SETUP.md, Auth0 section)."
            ),
        )
    resp = httpx.post(
        f"https://{config.AUTH0_DOMAIN}/oauth/token",
        json={
            "client_id": config.AUTH0_TOKEN_VAULT_CLIENT_ID,
            "client_secret": config.AUTH0_TOKEN_VAULT_CLIENT_SECRET,
            "grant_type": TOKEN_EXCHANGE_GRANT,
            "subject_token": auth0_access_token,
            "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
            "requested_token_type": (
                "http://auth0.com/oauth/token-type/federated-connection-access-token"
            ),
            "connection": config.AUTH0_SPOTIFY_CONNECTION,
        },
        timeout=30,
    )
    if resp.status_code != 200:
        log.error("Token Vault exchange failed: %s %s", resp.status_code, resp.text)
        raise HTTPException(
            status_code=502,
            detail=(
                "Auth0 Token Vault exchange failed. Has this user connected their "
                f"Spotify account via the '{config.AUTH0_SPOTIFY_CONNECTION}' "
                f"connection? Auth0 said: {resp.text[:300]}"
            ),
        )
    return resp.json()["access_token"]


def _sp_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def search_track_uri(client: httpx.Client, token: str, title: str, artist: str) -> str | None:
    """Search Spotify for a track uri. Development Mode caps results at 10."""
    q = f"track:{title} artist:{artist}" if artist else title
    resp = client.get(
        f"{SPOTIFY_API}/search",
        headers=_sp_headers(token),
        params={"q": q, "type": "track", "limit": 5},
    )
    if resp.status_code != 200:
        log.warning("spotify search failed for %r: %s", q, resp.text[:200])
        return None
    items = resp.json().get("tracks", {}).get("items", [])
    return items[0]["uri"] if items else None


def export_playlist(
    auth0_access_token: str,
    name: str,
    description: str,
    tracks: list[dict[str, Any]],
) -> dict[str, Any]:
    """Create a playlist and populate it. `tracks` entries carry either a known
    `spotify_uri` (from the songs collection) or `title`/`artist` to search."""
    token = spotify_token_from_vault(auth0_access_token)

    with httpx.Client(timeout=30) as client:
        me = client.get(f"{SPOTIFY_API}/me", headers=_sp_headers(token))
        if me.status_code != 200:
            raise HTTPException(status_code=502, detail=f"spotify /me failed: {me.text[:300]}")
        spotify_user_id = me.json()["id"]

        uris: list[str] = []
        missing: list[dict[str, Any]] = []
        for t in tracks:
            uri = t.get("spotify_uri")
            if not uri:
                uri = search_track_uri(client, token, t.get("title") or "", t.get("artist") or "")
            if uri:
                uris.append(uri)
            else:
                missing.append({"title": t.get("title"), "artist": t.get("artist")})

        created = client.post(
            f"{SPOTIFY_API}/users/{spotify_user_id}/playlists",
            headers=_sp_headers(token),
            json={"name": name, "description": description, "public": False},
        )
        if created.status_code not in (200, 201):
            raise HTTPException(
                status_code=502, detail=f"playlist create failed: {created.text[:300]}"
            )
        playlist = created.json()

        if uris:
            added = client.post(
                f"{SPOTIFY_API}/playlists/{playlist['id']}/tracks",
                headers=_sp_headers(token),
                json={"uris": uris[:100]},
            )
            if added.status_code not in (200, 201):
                raise HTTPException(
                    status_code=502, detail=f"add tracks failed: {added.text[:300]}"
                )

    return {
        "playlist_id": playlist["id"],
        "playlist_url": playlist.get("external_urls", {}).get("spotify"),
        "added": len(uris),
        "not_found_on_spotify": missing,
    }
