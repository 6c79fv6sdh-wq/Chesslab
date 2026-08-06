from chess_dossier.domain.errors import DomainError


class AnalysisError(DomainError):
    """The corpus cannot produce a trustworthy analysis result."""


class EngineUnavailable(AnalysisError):
    """The configured UCI engine cannot be started or queried."""


class SourceFetchError(AnalysisError):
    """A remote game source did not return a usable corpus."""
