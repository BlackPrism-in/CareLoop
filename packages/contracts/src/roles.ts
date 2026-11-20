import { z } from 'zod';

/** Staff roles (MVP spec §03). Patients are not members and never get a role. */
export const StaffRole = z.enum(['OWNER', 'REVIEWER', 'COORDINATOR', 'VERIFIER', 'AUDITOR']);
export type StaffRole = z.infer<typeof StaffRole>;

export const MembershipStatus = z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED']);
export type MembershipStatus = z.infer<typeof MembershipStatus>;
