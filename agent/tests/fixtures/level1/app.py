"""Simple calculator module for benchmark level 1."""


class Calculator:
    """A basic calculator that records operation history."""

    def __init__(self):
        self.history = []

    def add(self, a, b):
        result = a + b
        self._record("add", result)
        return result

    def multiply(self, a, b):
        result = a * b
        self._record("multiply", result)
        return result

    def _record(self, operation, result):
        self.history.append({"op": operation, "result": result})


def main():
    calc = Calculator()
    print(calc.add(2, 3))
    print(calc.multiply(4, 5))


if __name__ == "__main__":
    main()
