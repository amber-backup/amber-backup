import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** Marks a route as not requiring authentication. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const IS_ADMIN_KEY = 'requireAdmin';
/** Marks a route/controller as admin-only. */
export const RequireAdmin = () => SetMetadata(IS_ADMIN_KEY, true);

export const ADMIN_API_KEY_KEY = 'adminApiKey';
/**
 * Opens an admin-only route to an administrator's API key (e.g. the CLI's
 * saved login). Reads accept any key scope; state-changing requests need a
 * full-access key (`*`). Admin routes without it stay session-only.
 */
export const AllowAdminApiKey = () => SetMetadata(ADMIN_API_KEY_KEY, true);

export const REQUIRED_ACTION_KEY = 'requiredAction';
/** Declares the API-key action scope a route needs (e.g. 'read','backup'). */
export const RequireAction = (action: string) =>
  SetMetadata(REQUIRED_ACTION_KEY, action);

export const NO_API_KEY_KEY = 'noApiKey';
/**
 * Marks a route/controller as unreachable via an API key (session auth only) —
 * e.g. API-key management, so a key can never mint or revoke keys.
 */
export const NoApiKey = () => SetMetadata(NO_API_KEY_KEY, true);

export const ANY_API_KEY_SCOPE_KEY = 'anyApiKeyScope';
/**
 * Lets a key of any scope call a mutating route — only for operations that act
 * on the calling key itself (e.g. a read-only key revoking itself on logout).
 */
export const AnyApiKeyScope = () => SetMetadata(ANY_API_KEY_SCOPE_KEY, true);
