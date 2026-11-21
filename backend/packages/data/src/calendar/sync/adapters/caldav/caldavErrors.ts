/** The CalDAV server refused the login at connect. */
export class CalDavAuthFailedError extends Error {
  readonly code = "caldav_auth_failed";
  constructor() {
    super("The CalDAV server rejected the login");
    this.name = "CalDavAuthFailedError";
  }
}

/**
 * The CalDAV address is refused by the outbound address policy, or the server is unreachable or did not answer in
 * time. One error with no cause and no address, so a refused address and an unreachable server look identical.
 */
export class CalDavServerUnreachableError extends Error {
  readonly code = "caldav_server_unreachable";
  constructor() {
    super("The CalDAV server could not be reached");
    this.name = "CalDavServerUnreachableError";
  }
}

/** The server answered, but not as a CalDAV server with a calendar home for this login. */
export class CalDavServerInvalidError extends Error {
  readonly code = "caldav_server_invalid";
  constructor() {
    super("The server did not answer as a CalDAV server");
    this.name = "CalDavServerInvalidError";
  }
}
