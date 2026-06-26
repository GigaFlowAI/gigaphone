"""Language-pack registry. New language = register a pack here; no engine change (ADR-0002)."""

from __future__ import annotations

from gigaphone.interfaces.language_pack import LanguagePack
from gigaphone.packs.python import PythonPack
from gigaphone.packs.rust import RustPack
from gigaphone.packs.typescript import TypeScriptPack

_PACKS: list[LanguagePack] = [PythonPack(), TypeScriptPack(), RustPack()]


def all_packs() -> list[LanguagePack]:
    return list(_PACKS)


def pack_for_path(path: str) -> LanguagePack | None:
    for pack in _PACKS:
        if path.endswith(pack.extensions):
            return pack
    return None


def pack_by_id(pack_id: str) -> LanguagePack | None:
    return next((p for p in _PACKS if p.id == pack_id), None)
