class DomainError(Exception):
    """Base error safe to translate into a user-facing message."""


class InvalidTransition(DomainError):
    pass


class OrderNotFound(DomainError):
    pass


class AccessDenied(DomainError):
    pass


class CapacityExceeded(DomainError):
    pass


class ActiveOrderExists(DomainError):
    pass


class InvalidSource(DomainError):
    pass


class InvalidArtifact(DomainError):
    pass


class PaymentError(DomainError):
    pass
