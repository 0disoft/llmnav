# Language examples

## TypeScript and JavaScript

Place file or module cards before imports. Symbol cards may precede JSDoc and decorators.

```ts
/* llmnav/1 symbol
id=billing.credit.reserve
role=Reserve credits before an external generation job starts.
search=credit hold|reserve credits|generation billing
invariant=Captured credits never exceed the active reservation.
effect=db.write(credit_reservations)
risk=concurrency
stability=contract
*/
/** Creates an expiring reservation. */
export async function reserveCredits() {}
```

## Go

A Go package card belongs after `package` and before `import` so it does not interfere with the normal package doc comment.

```go
package session

/* llmnav/1 module
id=auth.session
role=Own refresh-token issuance, rotation, replay detection, and revocation.
owns=refresh-token family|session revocation
excludes=access-token signing|user profile storage
search=session renewal|refresh token|token replay
invariant=One token family has at most one live refresh token.
stability=architecture
*/

import "context"
```

A symbol card belongs before the ordinary exported declaration comment.

```go
/* llmnav/1 symbol
id=auth.session.rotate
role=Rotate one refresh-token family atomically and reject replayed tokens.
search=refresh token|token rotation|replay detection
stability=contract
*/

// RotateSession returns the replacement token.
func RotateSession(ctx context.Context) error { return nil }
```

## Rust

```rust
/* llmnav/1 symbol
id=privacy.export.prepare
role=Build one immutable export manifest from the user's authorized data snapshot.
search=data export|privacy archive|export manifest
invariant=Every manifest entry belongs to the authorized subject.
effect=db.read(privacy_snapshot)|fs.write
risk=privacy
rel=test>privacy.export.prepare.contract
stability=contract
*/
pub async fn prepare_export() -> Result<Manifest, Error> {
    todo!()
}
```

## Python

Use explicit `# /llmnav` termination. The card may precede decorators.

```py
# llmnav/1 symbol
# id=billing.payment.apply-provider-event
# role=Apply one provider event idempotently to the payment ledger.
# search=duplicate webhook|provider event|payment idempotency
# invariant=One provider event ID changes the ledger at most once.
# effect=db.write(payment_ledger)
# risk=money
# rel=test>billing.payment.apply-provider-event.contract
# stability=contract
# /llmnav
@transactional
def apply_provider_event(event):
    ...
```

## SQL

Use `--` line cards for migration files and terminate explicitly.

```sql
-- llmnav/1 file
-- id=billing.migration.credit-reservations
-- role=Create the reservation ledger without changing existing credit balances.
-- search=credit migration|reservation ledger|billing schema
-- invariant=Existing account balances remain unchanged after migration.
-- effect=db.write(schema)
-- risk=migration|money
-- rel=test>billing.migration.credit-reservations.contract
-- stability=contract
-- /llmnav

CREATE TABLE credit_reservations (...);
```

## Svelte, Astro, Vue, and HTML

Use a block comment inside the script region when the card attaches to a script declaration. Use an HTML comment for a component or page file card.

```svelte
<!-- llmnav/1 file
id=ui.checkout.page
role=Render checkout state and submit one payment confirmation request.
search=checkout page|payment confirmation|purchase flow
effect=net.call(billing.confirm)
risk=money
rel=test>ui.checkout.page.contract
stability=contract
-->
```

## Shell and YAML-adjacent files

Use `#` cards only in source types included by configuration. LLMNav does not scan Markdown or YAML by default because documentation examples and configuration comments would create false cards.
