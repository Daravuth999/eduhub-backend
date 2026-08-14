"""
generate_session.py — Run this ONCE locally to get your TG_SESSION_STRING
=========================================================================
This script logs into Telegram interactively (asks for your phone + OTP),
then prints a session string you paste into Render as TG_SESSION_STRING.

After that, telegram_listener.py runs headlessly on Render with no phone needed.

Run:
  pip install telethon
  python generate_session.py
"""

import asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession

API_ID   = 38009767
API_HASH = "8f1ebbc30ada063b66015b467f64241b"


async def main():
    print("\n" + "=" * 60)
    print("EduHub — Telegram Session Generator")
    print("=" * 60)
    print("\nThis will log into your Telegram account.")
    print("You will receive an OTP code in Telegram.\n")

    client = TelegramClient(StringSession(), API_ID, API_HASH)
    await client.start()

    session_string = client.session.save()

    print("\n" + "=" * 60)
    print("✅ SUCCESS — Copy the string below into Render:")
    print("   Environment variable name: TG_SESSION_STRING")
    print("=" * 60)
    print(f"\n{session_string}\n")
    print("=" * 60)
    print("Keep this string secret — it gives access to your Telegram account.")
    print("=" * 60 + "\n")

    await client.disconnect()


asyncio.run(main())
