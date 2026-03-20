---
trigger: always_on
---

An iPhone and iPad app that was written by me and a partner lives at https://github.com/EmeraldSequoia/Chronometer.

This project is about porting that app from its current implementation in Objective-C, C++, and C that runs on an iOS device to a web app that runs in a user's browser.

Like the existing app, which never needs to contact any servers and uses only the time and location from the user's device, I want the web app to not contact any backend servers at all either. It should be a static app that runs entirely in TypeScript; this will allow it to run directly from the GitHub IO directory.
