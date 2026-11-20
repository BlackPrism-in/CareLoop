import { staffRoute } from '@/server/handler';
import { BookingListQuery } from '@/server/schemas';
import { jobQueries } from '@/server/services';
import type { BookingStatus } from '@careloop/jobs';

export const dynamic = 'force-dynamic';

const GROUPS: Record<'open' | 'confirmed' | 'closed', BookingStatus[]> = {
  open: ['REQUESTED', 'PENDING_STAFF', 'UNKNOWN', 'CANCEL_PENDING'],
  confirmed: ['CONFIRMED'],
  closed: ['REJECTED', 'CANCELLED'],
};

export const GET = staffRoute(async ({ req, session }) => {
  const q = BookingListQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
  return Response.json({
    items: await jobQueries().listBookings(session.ctx.tenantId, GROUPS[q.status]),
  });
});
