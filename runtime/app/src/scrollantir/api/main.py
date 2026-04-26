from fastapi import FastAPI

app = FastAPI(title="scrollantir api")


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}
