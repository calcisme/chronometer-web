---
trigger: always_on
---

An iPhone and iPad app that was written by me and a partner lives at https://github.com/EmeraldSequoia/Chronometer.

This project is about porting that app from its current implementation in Objective-C, C++, and C that runs on an iOS device to a web app that runs in a user's browser.

Like the existing app, which never needs to contact any servers and uses only the time and location from the user's device, I want the web app to not contact any backend servers at all either. It should be a static app that runs entirely in TypeScript; this will allow it to run directly from the GitHub IO directory

The original iOS app has two variants:
* "Henry", a preprocessor app that also runs on iOS (typically a simulator) reads XML files for each watch face, and creates two artifacts for each face:
    * A "texture atlas", with the rendered pixels for each "hand" on the face
    * A binary-format "archive" file, which contains information for each hand like where it should appear and how it should move over time.
        * The numeric parameters are almost always "C expressions", which Henry parses using a simple custom lex/yacc parser into binary expressions
* The app actually used by customers, called Chronometer, which reads the artifacts created by Henry and renders them using OpenGL 1.x
    * It reads the texture atlas files and keeps them in memory
    * It reads the "archive" binary file and uses that to know where, when, and how to update the hands
