---
trigger: always_on
---

An iPhone and iPad app that was written by Steve Pucci & Bill Arnett lives at https://github.com/EmeraldSequoia/Chronometer.

This project is a port of that app from the implementation in Objective-C, C++, and C that runs on an iOS device to a web app that runs in a user's browser. There is also an Android port of this code, but it is not available in github other than the XML files for Android.

The web app is to not contact any backend servers at all either for any core functionality. It should be a static app that runs entirely in TypeScript. This will allow it to run from any web server simply by serving the static files.

The original iOS app has two variants:
* "Henry", a preprocessor app that also runs on iOS (typically a simulator) reads XML files for each watch face, and creates two artifacts for each face:
    * A "texture atlas", with the rendered pixels for each "hand" on the face
    * A binary-format "archive" file, which contains information for each hand like where it should appear and how it should move over time.
        * The numeric parameters are almost always "C expressions", which Henry parses using a simple custom lex/yacc parser into binary expressions
* The app actually used by customers, called Chronometer, which reads the artifacts created by Henry and renders them using OpenGL 1.x
    * It reads the texture atlas files and keeps them in memory
    * It reads the "archive" binary file and uses that to know where, when, and how to update the hands

For **all** tasks and queries to the agent when developing this project, **always** refer to the document in docs/development-rules.md and follow those rules explicitly. Also use any other documents in that directory to provide background information useful to the query or task.
