package session

/* llmnav/1 module
id=example.billing.credit
role=Own credit reservation and capture boundaries for generation jobs.
owns=credit reservation|reservation capture
excludes=provider invoice settlement|subscription entitlement
search=credit hold|generation billing|reserve credits
invariant=Captured credits never exceed the active reservation.
stability=architecture
*/

type Reservation struct {
	ID     string
	Amount int64
}

/* llmnav/1 symbol
id=example.billing.credit.reserve
role=Reserve credits before an external generation job starts.
search=credit hold|reserve credits|generation billing
invariant=One idempotency key creates at most one active reservation.
effect=db.write(credit_reservations)
risk=concurrency
stability=contract
*/

func ReserveCredits(accountID string, amount int64, idempotencyKey string) Reservation {
	return Reservation{ID: accountID + ":" + idempotencyKey, Amount: amount}
}
