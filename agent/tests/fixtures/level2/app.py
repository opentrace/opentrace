"""Application entry point for benchmark level 2."""

from service import UserService


def main():
    svc = UserService()
    svc.create_user("Alice", "alice@example.com")
    svc.create_user("Bob", "bob@example.com")
    for user in svc.list_users():
        print(user)


if __name__ == "__main__":
    main()
