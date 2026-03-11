def greet(name):
    return f"Hi {name}"

def add(a: int, b: int) -> int:
    return a + b

async def fetch_data(url: str):
    response = await get(url)
    return response
