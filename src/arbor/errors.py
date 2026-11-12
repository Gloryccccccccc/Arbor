class ArborError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def error_info(error: BaseException) -> dict[str, str]:
    if isinstance(error, ArborError):
        return {"code": error.code, "message": str(error)}
    # Never include request objects, headers or exception reprs from HTTP libraries.
    return {"code": "internal", "message": "An internal operation failed."}
