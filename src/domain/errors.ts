export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** Ressource inexistante OU appartenant à une autre entreprise (on ne distingue pas : pas de fuite d'existence). */
export class NotFoundError extends DomainError {
  constructor(what: string) {
    super(`${what} introuvable`, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "Action non autorisée") {
    super(message, "FORBIDDEN");
    this.name = "ForbiddenError";
  }
}

export class ValidationError extends DomainError {
  constructor(
    message: string,
    public readonly issues: string[] = [message],
  ) {
    super(message, "VALIDATION");
    this.name = "ValidationError";
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, code = "CONFLICT") {
    super(message, code);
    this.name = "ConflictError";
  }
}
