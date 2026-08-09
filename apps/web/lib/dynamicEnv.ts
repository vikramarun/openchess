/** Dynamic's environment id, and whether sign-in is configured at all.
 *
 *  Kept in one module because a missing id can't be handled locally: passing an
 *  empty one to DynamicContextProvider makes it THROW during render, which the
 *  root error boundary turns into a blank page — so a single unset env var takes
 *  down spectating, replays, profiles and casual play, none of which need a
 *  wallet. Instead the provider tree and the two components that call Dynamic
 *  hooks all branch on `dynamicConfigured`, so an unconfigured deploy loses
 *  exactly the sign-in button and nothing else. */
export const DYNAMIC_ENV_ID = process.env.NEXT_PUBLIC_DYNAMIC_ENV_ID;

export const dynamicConfigured = !!DYNAMIC_ENV_ID;
