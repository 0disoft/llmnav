/* llmnav/1 module
id=example.auth.session
role=Own refresh-token rotation, replay detection, and family revocation for the example service.
owns=refresh-token family|session revocation
excludes=access-token signing|user profile storage
search=session lifecycle|token family|session revocation
invariant=One token family has at most one live refresh token.
stability=architecture
*/

export interface RotateSessionInput {
  familyId: string;
  presentedTokenHash: string;
}

export interface RotateSessionResult {
  replacementToken: string;
  familyRevoked: boolean;
}

/* llmnav/1 symbol
id=example.auth.session.rotate
role=Rotate one refresh-token family atomically and reject a replayed token.
search=refresh token|token rotation|token replay|session renewal
invariant=At most one live refresh token exists per family.
invariant=Replay revokes the entire token family.
effect=db.write(session_tokens)|event.emit(auth.session.revoked)
risk=auth|concurrency
rel=test>example.auth.session.rotate-contract
stability=contract
*/

export async function rotateSession(
  input: RotateSessionInput,
): Promise<RotateSessionResult> {
  void input;
  return { replacementToken: "example", familyRevoked: false };
}

/* llmnav/1 symbol
id=example.auth.session.rotate-contract
role=Verify rotation preserves single-token and replay-revocation guarantees.
search=rotation contract|replay revocation|session invariant
stability=contract
*/

export function assertRotateSessionContract(): void {
  // Replace with repository-specific tests.
}
