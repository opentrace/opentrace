@app.route("/api/users")
def list_users():
    return get_all()

@dataclass
class Config:
    host: str
    port: int
