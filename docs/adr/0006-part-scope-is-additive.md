# Part scope is additive across Project, folder and Rundown

Parts can be defined on a Project, on a folder of Rundowns, or on a single Rundown. A
Rundown sees the union of all three. A narrower scope can only add Parts, never redefine or
hide one from a broader scope.

Shadowing and replacement were both considered and rejected. Under either, the same Part
name resolves to different text depending on which Rundown you look at it from, and the
Announcement cache is keyed on text (ADR 0005) — so one name would have to mean several
cached clips, and "is this Part rendered?" would stop having an answer. Additive scoping
keeps a Call's `part_id` resolving identically everywhere.

## Consequences

Scope governs the Part *picker*, never resolution: a Call's Part is a hard foreign key, so
moving a Rundown between folders never breaks an existing Call, it only changes which Parts
can be chosen for new ones. Out-of-scope Parts still in use appear greyed in the picker.

Folders are a TEXT column on `rundowns`, not an entity, so a folder rename must update the
matching Part rows in the same transaction.
