# Login Flow

The login service authenticates users against the credential store and
issues a session token. Each request to the user dashboard is validated
against that token by the dashboard service.

The login service depends on the credential store. The dashboard service
trusts session tokens issued by the login service.
