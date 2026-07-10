import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** Marks a route as not requiring authentication. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const IS_ADMIN_KEY = 'requireAdmin';
/** Marks a route/controller as admin-only. */
export const RequireAdmin = () => SetMetadata(IS_ADMIN_KEY, true);

export const REQUIRED_ACTION_KEY = 'requiredAction';
/** Declares the API-key action scope a route needs (e.g. 'read','backup'). */
export const RequireAction = (action: string) =>
  SetMetadata(REQUIRED_ACTION_KEY, action);
