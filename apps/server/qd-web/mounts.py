from __future__ import annotations

import importlib
import os
from typing import Any, Callable


def load_mail(
    mailbox: Any,
    gate: Any,
    clock: Callable[[], float],
    mail_state_path: str | None,
    mail_state: Callable[[], str | None],
) -> Any:
    try:
        module = importlib.import_module("mail_api")
    except ModuleNotFoundError as error:
        if error.name == "mail_api":
            return None
        raise
    if (
        not isinstance(mail_state_path, str)
        or not os.path.isabs(mail_state_path)
        or not os.path.isdir(os.path.dirname(mail_state_path))
    ):
        raise RuntimeError("Captain mail state path is invalid")
    return module.MailApi(
        mailbox,
        gate,
        clock=clock,
        mail_state_path=mail_state_path,
        mail_state=mail_state,
    )
