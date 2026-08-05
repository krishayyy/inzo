export class RelayError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

export const notFound = (message: string) => new RelayError(message, 404, "not_found");
export const badRequest = (message: string) => new RelayError(message, 400, "bad_request");
export const conflict = (message: string) => new RelayError(message, 409, "conflict");
export const forbidden = (message: string) => new RelayError(message, 403, "forbidden");
export const gone = (message: string) => new RelayError(message, 410, "gone");
export const unauthenticated = (message = "A valid bearer token is required") => new RelayError(message, 401, "unauthenticated");
export const identityNotAllowed = () => new RelayError("Identity must be derived from the bearer token, not the request body", 400, "identity_not_allowed");

/**
 * The token was genuine but has been revoked — by its own holder, or by the
 * peer pulling the kill switch. Deliberately distinct from `unauthenticated`
 * so a client can tell "you were ejected" apart from "your credential is wrong".
 */
export const revoked = (message = "This agent credential has been revoked") =>
  new RelayError(message, 401, "revoked");

/** Token is genuine and in the right pairing, but does not carry the capability. */
export const insufficientScope = (required: string) =>
  new RelayError(`This credential does not carry the "${required}" capability`, 403, "insufficient_scope");

/** An approval raced a re-proposal: the human approved a version that is no longer current. */
export const stalePlan = (submitted: unknown, current: number) =>
  new RelayError(
    `Plan version ${String(submitted)} is stale; the current plan is version ${current}. Re-read the plan before approving.`,
    409,
    "stale_plan",
  );

export const rateLimited = (message: string) => new RelayError(message, 429, "rate_limited");

// --- v3: signed credentials, proof of possession, consent -----------------

/** Signature and chain were fine; the credential simply aged out. Distinct from
 *  `unauthenticated` so a client knows to re-issue rather than re-pair. */
export const credentialExpired = (message = "This credential has expired") =>
  new RelayError(message, 401, "credential_expired");

export const proofInvalid = (message: string) => new RelayError(message, 401, "proof_invalid");
export const proofStale = (message: string) => new RelayError(message, 401, "proof_stale");

/** A proof is valid for its whole window, so an observer could otherwise repeat
 *  a captured request verbatim until the window closed. */
export const proofReplayed = () =>
  new RelayError("This proof has already been used", 401, "proof_replayed");

/** Credentials must be bound to a holder key at issue — there is no
 *  bearer-only path in v3, because a bearer token cannot prove possession. */
export const popRequired = () =>
  new RelayError(
    "cnf.jwk is required: generate an Ed25519 keypair locally and send only the public half",
    400,
    "pop_required",
  );

/**
 * Consent is the one place a bearer credential is never good enough.
 *
 * An approval's whole value is that it is non-repudiable — signed by a key the
 * relay has never held. A bearer credential can only produce an assertion by
 * the relay, which is exactly what v3 exists to stop relying on.
 */
export const popRequiredForConsent = () =>
  new RelayError(
    "Consent requires a proof-of-possession credential; a bearer credential cannot produce a non-repudiable approval",
    403,
    "pop_required_for_consent",
  );

export const depthExceeded = (depth: number, max: number) =>
  new RelayError(`Delegation depth ${depth} exceeds the limit of ${max}`, 400, "depth_exceeded");

/**
 * Version matched but the content hash did not.
 *
 * Not an ordinary stale approval — a version is a counter and can collide
 * across a restore or a bad migration, while the hash is over the content
 * itself. Same wire code as `stale_plan` so clients need no new branch, but
 * the message says plainly that this one is an integrity problem.
 */
export const subjectHashMismatch = (expected: string, actual: string) =>
  new RelayError(
    `Plan content hash does not match the approved subject (expected ${expected}, got ${actual}). ` +
      `The version matched but the content did not — treat this as an integrity incident, not a stale read.`,
    409,
    "stale_plan",
  );
