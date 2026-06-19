import { cookies } from 'next/headers';
import { auth } from './auth';

export const IMPERSONATE_COOKIE = 'act_as';

export interface AuthContext {
  /** The real logged-in user (never changes via impersonation). */
  realUserId: string;
  /** Whether the real user is an admin. */
  isAdmin: boolean;
  /** The user whose data the request should operate on. */
  effectiveUserId: string;
  /** True when an admin is acting as a different user. */
  impersonating: boolean;
}

/**
 * Resolves the auth context for a request, honoring admin impersonation.
 *
 * The `act_as` cookie is only respected when the real, server-verified session
 * user is an admin — so a forged cookie from a non-admin has no effect.
 *
 * Returns `null` when there is no authenticated user.
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const session = await auth();
  const realUserId = session?.user?.id;
  if (!realUserId) return null;

  const isAdmin = session.user.isAdmin === true;

  let effectiveUserId = realUserId;
  let impersonating = false;

  if (isAdmin) {
    const actAs = (await cookies()).get(IMPERSONATE_COOKIE)?.value;
    if (actAs && actAs !== realUserId) {
      effectiveUserId = actAs;
      impersonating = true;
    }
  }

  return { realUserId, isAdmin, effectiveUserId, impersonating };
}
