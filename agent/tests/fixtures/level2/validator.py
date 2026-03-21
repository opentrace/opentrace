"""Validation functions for benchmark level 2."""

import re


def validate_email(email):
    """Check if email has a valid format."""
    return bool(re.match(r"^[^@]+@[^@]+\.[^@]+$", email))


def validate_name(name):
    """Check if name is non-empty and reasonable length."""
    return isinstance(name, str) and 0 < len(name) <= 100
