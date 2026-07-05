# TCP proxy run INSIDE the trezor-user-env container (copied there by
# setup-trezor.mjs). trezord-go (the legacy bridge, v2.0.33) binds
# 127.0.0.1:21325 inside the container only; Docker's port forwarding cannot
# reach loopback-bound services, so this proxy re-exposes it on 0.0.0.0:21327,
# which docker-compose publishes to the host as 31325.
import asyncio

LISTEN_PORT = 21327
TARGET_HOST = "127.0.0.1"
TARGET_PORT = 21325


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        writer.close()


async def handle(reader, writer):
    try:
        tr, tw = await asyncio.open_connection(TARGET_HOST, TARGET_PORT)
    except Exception:
        writer.close()
        return
    await asyncio.gather(pipe(reader, tw), pipe(tr, writer))


async def main():
    server = await asyncio.start_server(handle, "0.0.0.0", LISTEN_PORT)
    print(f"proxying 0.0.0.0:{LISTEN_PORT} -> {TARGET_HOST}:{TARGET_PORT}")
    async with server:
        await server.serve_forever()


asyncio.run(main())
