# Coordination sandbox data

`evening_booking.json` is a synthetic case and fake booking-adapter inventory
for exercising the Coordination gateway. It contains no patient data. The
evening slot matches the structured preference; the daytime slot should be
rejected by the preference check.

The fixture's `case` object includes sandbox-only fields (`tenantId`, `ownerId`,
and `handoffDueAt`) used to seed `InMemoryCoordinationWorld`. Remove those
fields before parsing it as `CoordinationContext`; pass `tenantId` separately
to `actorForMemoryCase()`. Seed `slots` with `world.addSlots(...)`.

There is not yet a Coordination HTTP route, so this fixture cannot currently
be submitted to Postman or curl. It is ready for a local fake-world runner/API
to be added. Do not use these fake identity or tenant values outside local
development.
