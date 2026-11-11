#!/usr/bin/env python3
"""wire_ref.py — an INDEPENDENT Python 3 reference implementation of the
BAO Court ESCALATION REQUEST WIRE (`courtEscalationRequest.ts`, v0.14.x).

WHY THIS FILE EXISTS. Every test of the TypeScript codec is written against the
codec it tests, so a *shared* misreading of the contract — a field order, a
sentinel, a definition of "whitespace" — is invisible to the suite: both the
implementation and its oracle are wrong in the same direction. This file is a
second implementation, written from the *prose* (see SPEC SOURCES below) in a
different language and with different primitives (hashlib, the stdlib JSON
scanner, explicit code-point sets), so the two can only agree by both matching
the contract. `scripts/differential/run.mjs` drives both over a seeded corpus
and reports every disagreement.

SPEC SOURCES (what this file was written FROM, in the order it was read):
  * `docs/PER_ROUND_BOND.md` § "Transport (R43, H-6)" and "The mapping needs the
    host's binding (r8-2)" — the wire fields, the optional witness, the host
    binding, the trust-anchor boundary.
  * `docs/REVIEW_ROUND_9.md` §1.1 (caseId is validated exactly, never folded),
    §2.6 (ambiguous bond ledger), §3 (duplicate keys, depth-1 argument).
  * `CHANGELOG.md` v0.14.0 / v0.14.1 / v0.14.2 entries (r8-1..r8-6, r9-1..r9-4).
  * the module JSDoc of `courtEscalationRequest.ts` — the contract's own prose
    summary (not its code): the nine wire fields, the `'-'` sentinel, the v2
    domain string, the preimage field order, the wire/host split of the event.

Where those sources are SILENT the reference makes an explicit decision and
records it in `docs/DIFFERENTIAL_WIRE.md` §5 (the check order, the exact
whitespace class, the numeric parse model). Those three are the interesting
ones: each is a corner where "the contract" is a sentence that two implementers
can read differently, and the differential exists to find exactly that.

DELIBERATE PROPERTIES (so a divergence is a finding, not a style difference):
  * stdlib only — no pip, no third-party crypto;
  * no JSON library shortcuts for the canonical form: the canonical serializer
    is written out, because `json.dumps` does not produce ECMAScript
    `JSON.stringify` bytes (escaping set, key order);
  * refusals are TYPED (`Refusal.code`), never string-compared: the harness maps
    both sides to one closed set of refusal classes and compares the class;
  * a JSON *number* is an IEEE-754 double (decision D3): the wire is JSON and a
    JS receiver parses numbers as doubles, so this reference does too.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sys

# --- contract constants (SPEC: JSDoc + REVIEW_ROUND_9 §1.1) ------------------

DOMAIN = "BAO-Court/Escalation/Request/v2"
WIRE_VERSION = 2
MAX_ROUND = 5
MAX_CASE_ID_BYTES = 256

#: The nine wire fields, in the order the canonical serializer emits them.
WIRE_FIELDS = (
    "caseId",
    "round",
    "challengerPubkey",
    "bondTxid",
    "bondProofHash",
    "roundBondProofHash",
    "eventId",
    "signedAtSec",
    "concession",
)

#: Canonical 32-byte lowercase hex (the codec's HEX_32).
HEX_32 = re.compile(r"\A[0-9a-f]{64}\Z")

#: The sentinel for an absent per-round witness; no hex32 can equal it.
ABSENT_WITNESS = "-"


class Refusal(Exception):
    """A typed refusal. `code` is the contract-level class the harness compares."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code if not detail else f"{code}: {detail}")
        self.code = code
        self.detail = detail


class _Absent:
    """A field that is not present at all (JS `undefined`)."""

    _singleton = None

    def __new__(cls):
        if cls._singleton is None:
            cls._singleton = super().__new__(cls)
        return cls._singleton

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "ABSENT"


ABSENT = _Absent()


# --- decision D1: the exact whitespace class --------------------------------
#
# The contract says an id "must not have leading or trailing whitespace" but
# never says WHAT whitespace is. This reference pins the ECMAScript definition —
# `String.prototype.trim`'s WhiteSpace + LineTerminator set — because the codec
# is a JavaScript library and that is the definition the sentence is implemented
# with. Note the two places this is NOT the Unicode `White_Space` property:
#   * U+0085 (NEL) and U+001C..U+001F are Unicode whitespace but are NOT
#     ECMAScript whitespace, so they are accepted as id characters here;
#   * U+FEFF (ZWNBSP) is ECMAScript whitespace but not Python's `str.isspace()`,
#     so it is REFUSED at an edge here.
# Any other choice (Python's `str.strip`, Unicode White_Space) disagrees with
# the shipped codec in at least one direction; see docs/DIFFERENTIAL_WIRE.md §5.
JS_WHITESPACE = frozenset(
    [
        "\u0009",  # TAB
        "\u000a",  # LF
        "\u000b",  # VT
        "\u000c",  # FF
        "\u000d",  # CR
        "\u0020",  # SP
        "\u00a0",  # NBSP
        "\u1680",  # OGHAM SPACE MARK
        "\u2000",  # EN QUAD
        "\u2001",
        "\u2002",
        "\u2003",
        "\u2004",
        "\u2005",
        "\u2006",
        "\u2007",
        "\u2008",
        "\u2009",
        "\u200a",  # HAIR SPACE
        "\u2028",  # LINE SEPARATOR
        "\u2029",  # PARAGRAPH SEPARATOR
        "\u202f",  # NARROW NBSP
        "\u205f",  # MEDIUM MATHEMATICAL SPACE
        "\u3000",  # IDEOGRAPHIC SPACE
        "\ufeff",  # ZERO WIDTH NO-BREAK SPACE (BOM)
    ]
)

_UPPER_SAFE = 2**53 - 1


def js_trim(text: str) -> str:
    """`String.prototype.trim` — leading/trailing code points in JS_WHITESPACE."""
    start, end = 0, len(text)
    while start < end and text[start] in JS_WHITESPACE:
        start += 1
    while end > start and text[end - 1] in JS_WHITESPACE:
        end -= 1
    return text[start:end]


# --- decision D3: numbers are IEEE-754 doubles ------------------------------


def is_safe_integer(value: object) -> bool:
    """`Number.isSafeInteger` — a boolean is NOT a number, and a float must be
    integral and within +/-(2**53 - 1)."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return abs(value) <= _UPPER_SAFE
    if isinstance(value, float):
        return math.isfinite(value) and value.is_integer() and abs(value) <= _UPPER_SAFE
    return False


def num_str(value: object) -> str:
    """`String(n)` for a safe integer: plain decimal, never `1.0` or `1e+21`."""
    if isinstance(value, bool):
        raise Refusal("panic", "bool formatted as a number")
    if isinstance(value, float):
        return str(int(value))
    return str(int(value))


def num_out(value: object) -> object:
    """Render an integral double as a JSON integer (JS has one number type)."""
    if isinstance(value, float) and value.is_integer() and abs(value) <= _UPPER_SAFE:
        return int(value)
    return value


def js_strict_equals(left: object, right: object) -> bool:
    """`===` over JSON values: numbers compare by value, booleans are not 0/1,
    and a number never equals its string spelling."""
    left_bool, right_bool = isinstance(left, bool), isinstance(right, bool)
    if left_bool or right_bool:
        return left_bool and right_bool and left is right
    left_num = isinstance(left, (int, float))
    right_num = isinstance(right, (int, float))
    if left_num or right_num:
        return left_num and right_num and left == right
    if left is None or right is None:
        return left is None and right is None
    if type(left) is not type(right):
        return False
    return left == right


# --- canonical text rules ---------------------------------------------------


def is_canonical_utf8(text: str) -> bool:
    """True when `text` is exactly the decoding of its own UTF-8 bytes.

    Two refusals, and the SECOND one is the interesting half:

    * an unpaired UTF-16 surrogate has no UTF-8 encoding (a JS `TextEncoder`
      replaces it with U+FFFD), so two distinct strings would share one
      preimage — the r8-1 collision. Python refuses to encode a lone surrogate
      over exactly the same set of strings, so `encode` is the test for that;
    * a decoder that does not preserve a leading BOM (WHATWG `TextDecoder`
      with the default `ignoreBOM: false`, which is what the shipped codec
      uses) STRIPS one leading U+FEFF, so a string that begins with U+FEFF
      also fails the round-trip.

    Decision D4 (docs/DIFFERENTIAL_WIRE.md §5): the round-trip — including the
    BOM strip — is the contract, not the phrase "no unpaired surrogates" the
    refusal message uses. Both readings REFUSE a leading-BOM id, so the accepted
    domain and its injectivity are identical; only the reported reason differs,
    and the shipped wording names a surrogate that is not there (registered as a
    diagnostic wart, not a soundness bug).
    """
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    # A BOM-stripping decoder returns the text minus one leading U+FEFF.
    return not text.startswith("\ufeff")


def validate_case_id(value: object, label: str) -> str:
    """Validate a case id EXACTLY (r8-1/r9-1): never fold, never normalise.

    Order matters and is part of the contract: type/emptiness before the
    canonical-UTF-8 check? No — the canonicality check is on the RAW value
    first (a fold must never mask a non-canonical string), then NUL, then the
    emptiness test, then the surrounding-whitespace refusal, then the byte
    bound. A 300-space id is therefore "empty", not "too long".
    """
    if not isinstance(value, str):
        raise Refusal("case_id_type_or_empty", f"{label} is not a string")
    if not is_canonical_utf8(value):
        raise Refusal("case_id_not_canonical", label)
    if "\u0000" in value:
        raise Refusal("case_id_nul", label)
    if js_trim(value) == "":
        raise Refusal("case_id_type_or_empty", f"{label} is empty")
    if value != js_trim(value):
        raise Refusal("case_id_whitespace", label)
    if len(value.encode("utf-8")) > MAX_CASE_ID_BYTES:
        raise Refusal("case_id_too_long", label)
    return value


def assert_hex32(value: object, field: str) -> str:
    if not isinstance(value, str) or not HEX_32.match(value):
        raise Refusal(f"hex32_{field}", field)
    return value


# --- build ------------------------------------------------------------------


def build_request(fields: object) -> dict:
    """Validate and normalise a request.

    `roundBondProofHash` may be absent or null (normalised to None); `concession`
    defaults to false; everything else is required. Field check ORDER is part of
    the contract (it decides which refusal a multi-fault input reports): caseId,
    round, roundBondProofHash, signedAtSec, concession, then the three identity
    hashes and the event id.
    """
    if not isinstance(fields, dict):
        # `build` is the typed constructor for a request OBJECT. A non-object
        # (null, an array, a string, a number) cannot be read field by field,
        # and the refusal is typed — never a raw interpreter error.
        raise Refusal("not_object", type(fields).__name__)

    case_id = validate_case_id(fields.get("caseId", ABSENT), "escalation request caseId")

    round_value = fields.get("round", ABSENT)
    if not is_safe_integer(round_value) or not (1 <= round_value <= MAX_ROUND):
        raise Refusal("round", repr(round_value))

    witness_raw = fields.get("roundBondProofHash", ABSENT)
    witness = None if witness_raw is ABSENT or witness_raw is None else assert_hex32(
        witness_raw, "round_bond_proof_hash"
    )

    signed_at = fields.get("signedAtSec", ABSENT)
    if not is_safe_integer(signed_at) or signed_at < 0:
        raise Refusal("signed_at", repr(signed_at))

    concession_raw = fields.get("concession", ABSENT)
    if concession_raw is not ABSENT and not isinstance(concession_raw, bool):
        raise Refusal("concession_type", repr(concession_raw))

    return {
        "caseId": case_id,
        "round": round_value,
        "challengerPubkey": assert_hex32(fields.get("challengerPubkey", ABSENT), "challenger_pubkey"),
        "bondTxid": assert_hex32(fields.get("bondTxid", ABSENT), "bond_txid"),
        "bondProofHash": assert_hex32(fields.get("bondProofHash", ABSENT), "bond_proof_hash"),
        "roundBondProofHash": witness,
        "eventId": assert_hex32(fields.get("eventId", ABSENT), "event_id"),
        "signedAtSec": signed_at,
        "concession": concession_raw is True,
    }


# --- preimage + hash --------------------------------------------------------


def preimage(request: dict) -> str:
    """`domain ‖ 0x00 ‖ caseId ‖ round ‖ challengerPubkey ‖ bondTxid ‖
    bondProofHash ‖ roundBondProofHash ‖ eventId ‖ signedAtSec ‖ concession`.

    Fields are joined with U+0000 (hence the NUL-free id rule), the absent
    witness is `-`, and the concession is `1`/`0` — never a JS truthiness.
    """
    witness = request["roundBondProofHash"]
    return "\u0000".join(
        [
            request["caseId"],
            num_str(request["round"]),
            request["challengerPubkey"],
            request["bondTxid"],
            request["bondProofHash"],
            ABSENT_WITNESS if witness is None else witness,
            request["eventId"],
            num_str(request["signedAtSec"]),
            "1" if request["concession"] else "0",
        ]
    )


def request_hash(request: dict) -> str:
    """sha256(domain ‖ 0x00 ‖ preimage), lowercase hex. Re-validates first."""
    normalised = build_request(request)
    digest = hashlib.sha256()
    digest.update(DOMAIN.encode("utf-8"))
    digest.update(b"\x00")
    digest.update(preimage(normalised).encode("utf-8"))
    return digest.hexdigest()


# --- canonical JSON ---------------------------------------------------------

_JSON_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def js_json_string(text: str) -> str:
    """ECMAScript `JSON.stringify` string quoting: the short escapes above,
    `\\u00XX` (lowercase) for the remaining C0 controls, everything else
    verbatim — no `\\u007f`, no `\\u2028`, no ASCII folding."""
    out = ['"']
    for char in text:
        escape = _JSON_ESCAPES.get(char)
        if escape is not None:
            out.append(escape)
        elif char < "\u0020":
            out.append("\\u%04x" % ord(char))
        elif "\ud800" <= char <= "\udfff":
            # Unreachable for an accepted request (validate_case_id refuses lone
            # surrogates); emitted the way a JS engine's well-formed stringify
            # would, so the two sides still agree if a field ever admitted one.
            out.append("\\u%04x" % ord(char))
        else:
            out.append(char)
    out.append('"')
    return "".join(out)


def serialize(request: dict) -> str:
    """The canonical wire string: declared field order, no whitespace, the
    witness slot ALWAYS present (null when absent)."""
    normalised = build_request(request)
    parts = []
    for field in WIRE_FIELDS:
        value = normalised[field]
        if isinstance(value, str):
            encoded = js_json_string(value)
        elif value is None:
            encoded = "null"
        elif isinstance(value, bool):
            encoded = "true" if value else "false"
        else:
            encoded = num_str(value)
        parts.append(f"{js_json_string(field)}:{encoded}")
    return "{" + ",".join(parts) + "}"


# --- parse ------------------------------------------------------------------


def _reject_constant(name: str) -> object:
    """`JSON.parse` has no NaN/Infinity literals; Python's json does."""
    raise ValueError(f"non-JSON constant {name}")


def _skip_string(text: str, index: int) -> int:
    """Index just past the JSON string starting at `index` (a quote)."""
    decoded_end = json.decoder.scanstring(text, index + 1)
    return decoded_end[1]


def _skip_value(text: str, index: int) -> int:
    """Index just past the JSON value starting at `index`."""
    char = text[index]
    if char == '"':
        return _skip_string(text, index)
    if char in "{[":
        depth = 0
        cursor = index
        while cursor < len(text):
            current = text[cursor]
            if current == '"':
                cursor = _skip_string(text, cursor)
                continue
            if current in "{[":
                depth += 1
            elif current in "}]":
                depth -= 1
                if depth == 0:
                    return cursor + 1
            cursor += 1
        raise Refusal("json", "unterminated value")
    cursor = index
    while cursor < len(text) and text[cursor] not in ",}] \t\r\n":
        cursor += 1
    return cursor


def assert_no_repeated_wire_fields(text: str) -> None:
    """Refuse a top-level object that repeats a field name (r8-4).

    Depth 1 only, deliberately: every wire field is a SCALAR, so a duplicate
    nested inside a value can only occur inside something the field's own type
    guard refuses anyway (REVIEW_ROUND_9 §3). Keys are compared after decoding,
    so `"c\\u0061seId"` and `"caseId"` are one field.
    """
    index = 0
    length = len(text)
    while index < length and text[index] in " \t\r\n":
        index += 1
    if index >= length or text[index] != "{":
        return  # the object-shape check reports this
    index += 1
    seen = set()
    while True:
        while index < length and text[index] in " \t\r\n":
            index += 1
        if index >= length or text[index] == "}":
            return
        key, index = json.decoder.scanstring(text, index + 1)
        while index < length and text[index] in " \t\r\n":
            index += 1
        if index >= length or text[index] != ":":
            raise Refusal("json", "expected ':'")
        index += 1
        if key in seen:
            raise Refusal("duplicate_key", key)
        seen.add(key)
        index = _skip_value(text, index)
        while index < length and text[index] in " \t\r\n":
            index += 1
        if index < length and text[index] == ",":
            index += 1
            continue
        if index >= length or text[index] == "}":
            return
        raise Refusal("json", "expected ',' or '}'")


def parse_request(raw: object) -> dict:
    """Decode a request from the wire text (or an already-parsed value).

    Unknown fields are a REFUSAL (additionalProperties: false), a repeated
    top-level field is a refusal, a missing witness is normalised to null and a
    missing concession to false. An already-parsed object cannot be checked for
    duplicates — that policy belongs to whoever parsed it.
    """
    value = raw
    if isinstance(raw, str):
        try:
            value = json.loads(raw, parse_int=float, parse_constant=_reject_constant)
        except Refusal:
            raise
        except Exception:
            raise Refusal("json", "JSON.parse rejected the body")
        assert_no_repeated_wire_fields(raw)
    if not isinstance(value, dict):
        raise Refusal("not_object", type(value).__name__)
    for key in value:
        if key not in WIRE_FIELDS:
            raise Refusal("unknown_field", key)
    return build_request(
        {
            "caseId": value.get("caseId", ABSENT),
            "round": value.get("round", ABSENT),
            "challengerPubkey": value.get("challengerPubkey", ABSENT),
            "bondTxid": value.get("bondTxid", ABSENT),
            "bondProofHash": value.get("bondProofHash", ABSENT),
            "roundBondProofHash": value.get("roundBondProofHash"),
            "eventId": value.get("eventId", ABSENT),
            "signedAtSec": value.get("signedAtSec", ABSENT),
            "concession": value.get("concession", ABSENT),
        }
    )


# --- wire -> machine event --------------------------------------------------


def to_machine_event(
    state: object,
    request: dict,
    now: object,
    binding: object = ABSENT,
) -> dict:
    """Build the reducer's `escalate` event.

    The wire supplies the challenger's claims; the CASE supplies everything the
    challenger must not choose — `challengerIdx` (the bond owner),
    `roundIndex` (`ladderRound + 1`) and `now`. Every refusal below is a typed
    gate the transport owes the reducer, in this order:

      1. the request itself re-validates (a hand-built object cannot bypass the
         codec);
      2. a CONCESSION is not an escalation (r9-3);
      3. the host binding: `caseId` (routed) and `authenticatedPubkey` (proved);
      4. the case id must match EXACTLY, the pubkey must match, and the round
         must be the round being resolved (r8-2);
      5. the case must have ONE round number (`ladderRound == ladder.round`,
         r9-4) and an open ladder;
      6. exactly one accepted challenge must carry the membership witness, and
         its `bondTxid` must be the one the request names (r9-2).
    """
    normalised = build_request(request)

    if normalised["concession"]:
        raise Refusal("concession_not_escalation")

    if binding is ABSENT or binding is None or not isinstance(binding, (dict, list)):
        # A JS `typeof binding !== 'object'` guard: a JSON array passes it, then
        # fails on the case-id read (pinned as a quirk in the doc, not a bug —
        # both paths refuse).
        raise Refusal("binding_missing")

    bound_case_id = validate_case_id(
        binding.get("caseId", ABSENT) if isinstance(binding, dict) else ABSENT,
        "escalation request binding caseId",
    )
    authenticated = binding.get("authenticatedPubkey", ABSENT) if isinstance(binding, dict) else ABSENT
    if not isinstance(authenticated, str) or not HEX_32.match(authenticated):
        raise Refusal("binding_pubkey_format")

    if normalised["caseId"] != bound_case_id:
        raise Refusal("binding_case_mismatch")

    if normalised["challengerPubkey"] != authenticated:
        raise Refusal("binding_pubkey_mismatch")

    if not isinstance(state, dict):
        raise Refusal("state_shape", "state is not an object")

    ladder_round = state.get("ladderRound", ABSENT)
    if not js_strict_equals(normalised["round"], ladder_round):
        raise Refusal("binding_round")

    ladder = state.get("ladder", ABSENT)
    if not isinstance(ladder, dict):
        raise Refusal("ladder_missing")
    if not js_strict_equals(ladder.get("round", ABSENT), ladder_round):
        raise Refusal("ladder_counters")

    challenges = state.get("challenges", ABSENT)
    if not isinstance(challenges, list):
        # A restored/tampered snapshot must fail CLOSED with a typed refusal —
        # never with a raw interpreter error (the repo's own `assertStateArrays`
        # doctrine; the differential found the shipped mapper missing it).
        raise Refusal("state_shape", "challenges is not an array")

    witness = normalised["bondProofHash"]
    bonds = [
        row
        for row in challenges
        if isinstance(row, dict) and js_strict_equals(row.get("bondProofHash", ABSENT), witness)
    ]
    if not bonds:
        raise Refusal("bond_none")
    if len(bonds) > 1:
        raise Refusal("bond_ambiguous")
    bond = bonds[0]

    if not js_strict_equals(normalised["bondTxid"], bond.get("bondTxid", ABSENT)):
        raise Refusal("bond_txid")

    if not is_safe_integer(now) or now < 0:
        raise Refusal("now")

    event = {
        "type": "escalate",
        "authority": "challenger",
        "challengerPubkey": normalised["challengerPubkey"],
        "requestHash": request_hash(normalised),
        "bondProofHash": normalised["bondProofHash"],
    }
    if "idx" in bond:
        event["challengerIdx"] = num_out(bond["idx"])
    if normalised["roundBondProofHash"] is not None:
        event["roundBondProofHash"] = normalised["roundBondProofHash"]
    event["roundIndex"] = num_out(ladder_round + 1) if isinstance(ladder_round, (int, float)) else None
    event["now"] = num_out(now)
    return event


# --- case evaluation (the harness protocol) ---------------------------------


def _accept(request: dict) -> dict:
    return {
        "outcome": "accept",
        "code": None,
        "preimage": preimage(request),
        "digest": request_hash(request),
        "serialized": serialize(request),
    }


def evaluate(case: dict) -> dict:
    """Evaluate ONE harness case. Mirrors the harness's four operations."""
    op = case.get("op")
    payload = case.get("payload")
    try:
        if op == "build":
            return _accept(build_request(payload))
        if op in ("parse_text", "parse_object"):
            return _accept(parse_request(payload))
        if op == "to_event":
            if not isinstance(payload, dict):
                raise Refusal("not_object", "to_event payload")
            described = payload.get("request", ABSENT)
            request = build_request({} if described is ABSENT or described is None else described)
            event = to_machine_event(
                payload.get("state", ABSENT),
                request,
                payload.get("now", ABSENT),
                payload.get("binding", ABSENT),
            )
            record = _accept(request)
            record["event"] = event
            return record
        raise Refusal("panic", f"unknown op {op!r}")
    except Refusal as refusal:
        return {"outcome": "refuse", "code": refusal.code, "detail": refusal.detail}
    except Exception as error:  # noqa: BLE001 - a crash is a finding, not a pass
        return {"outcome": "refuse", "code": "panic", "detail": type(error).__name__}


# --- self-test (the shared known answer, no TypeScript involved) ------------

_KAT_REQUEST = {
    "caseId": "court:market-r43-wire:1",
    "round": 1,
    "challengerPubkey": "7" * 64,
    "bondTxid": "d" * 64,
    "bondProofHash": "e" * 64,
    "roundBondProofHash": "a" * 64,
    "eventId": "8" * 64,
    "signedAtSec": 1_790_000_000,
}

#: The digest the host's `CourtEscalationService.ts` and the package suite both
#: pin (KNOWN ANSWER, v2 domain). Reproducing it from the prose is the cheapest
#: independent confirmation that this file read the contract correctly.
KAT_DIGEST = "38f94655c82847e158c451d02e338db9f6742d23556c029ed6b7773e0e0bab5f"
KAT_PREIMAGE = "\u0000".join(
    [
        "court:market-r43-wire:1",
        "1",
        "7" * 64,
        "d" * 64,
        "e" * 64,
        "a" * 64,
        "8" * 64,
        "1790000000",
        "0",
    ]
)


def selftest() -> int:
    failures = 0

    def check(name: str, actual: object, expected: object) -> None:
        nonlocal failures
        if actual != expected:
            failures += 1
            print(f"FAIL {name}: {actual!r} != {expected!r}")

    built = build_request(_KAT_REQUEST)
    check("kat preimage", preimage(built), KAT_PREIMAGE)
    check("kat digest", request_hash(built), KAT_DIGEST)
    check("kat serialize round-trip", parse_request(serialize(built)), built)
    check(
        "sentinel",
        preimage(build_request({**_KAT_REQUEST, "roundBondProofHash": None})),
        KAT_PREIMAGE.replace("a" * 64, "-"),
    )
    check("domain", DOMAIN, "BAO-Court/Escalation/Request/v2")
    check("concession bit", preimage(build_request({**_KAT_REQUEST, "concession": True})).endswith("\x001"), True)

    # Fail-closed spot checks (each is also in the 100k corpus).
    for label, payload, code in [
        ("folded id", {**_KAT_REQUEST, "caseId": "court:market-r43-wire:1 "}, "case_id_whitespace"),
        ("nel id edge", {**_KAT_REQUEST, "caseId": "\u0085court:1"}, None),
        # Decision D4: a LEADING U+FEFF is stripped by the round-trip decoder,
        # so it is refused as non-canonical; a TRAILING one is edge whitespace.
        ("feff leading", {**_KAT_REQUEST, "caseId": "\ufeffcourt:1"}, "case_id_not_canonical"),
        ("feff trailing", {**_KAT_REQUEST, "caseId": "court:1\ufeff"}, "case_id_whitespace"),
        ("feff interior", {**_KAT_REQUEST, "caseId": "court\ufeff:1"}, None),
        ("bom only", {**_KAT_REQUEST, "caseId": "\ufeff"}, "case_id_not_canonical"),
        ("nul id", {**_KAT_REQUEST, "caseId": "a\u0000b"}, "case_id_nul"),
        ("surrogate id", {**_KAT_REQUEST, "caseId": "a\ud800"}, "case_id_not_canonical"),
        ("long id", {**_KAT_REQUEST, "caseId": "x" * 257}, "case_id_too_long"),
        ("upper hex", {**_KAT_REQUEST, "eventId": "8" * 63 + "A"}, "hex32_event_id"),
        ("round 6", {**_KAT_REQUEST, "round": 6}, "round"),
        ("neg clock", {**_KAT_REQUEST, "signedAtSec": -1}, "signed_at"),
        ("string concession", {**_KAT_REQUEST, "concession": "true"}, "concession_type"),
    ]:
        try:
            build_request(payload)
            check(label, "accept", "accept" if code is None else "refuse")
        except Refusal as refusal:
            check(label, refusal.code, code if code is not None else "accept")

    print("selftest: %s" % ("OK" if failures == 0 else f"{failures} FAILURE(S)"))
    return 1 if failures else 0


# --- batch entry point ------------------------------------------------------


def run_batch(in_path: str, out_path: str) -> int:
    """Evaluate JSONL cases from `in_path`, write one JSONL result per line."""
    with open(in_path, "r", encoding="utf-8") as source, open(
        out_path, "w", encoding="utf-8"
    ) as sink:
        for line in source:
            line = line.strip()
            if not line:
                continue
            case = json.loads(line, parse_int=float, parse_constant=_reject_constant)
            result = evaluate(case)
            result["id"] = case.get("id")
            sink.write(json.dumps(result, ensure_ascii=True, sort_keys=True) + "\n")
    return 0


def main(argv: list) -> int:
    args = list(argv[1:])
    if "--selftest" in args:
        return selftest()
    in_path = out_path = None
    index = 0
    while index < len(args):
        if args[index] == "--in":
            in_path = args[index + 1]
            index += 2
        elif args[index] == "--out":
            out_path = args[index + 1]
            index += 2
        else:
            print(f"wire_ref.py: unknown argument {args[index]!r}", file=sys.stderr)
            return 2
    if in_path is None or out_path is None:
        print("usage: wire_ref.py --in <cases.jsonl> --out <results.jsonl> | --selftest", file=sys.stderr)
        return 2
    return run_batch(in_path, out_path)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
