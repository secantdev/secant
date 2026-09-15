# Pre-Drizzle Home Fixture

This home was created through the public Catalog and Run Store Interfaces at
commit `535d664de797bd626fac4f93d93a1c8b26210f9f`, immediately before issue #101
replaced the hand-written SQLite schema setup with Drizzle migrations.

It contains one Workspace approval and one unowned, halted Run for
`/fixture/workspace`. Migration tests copy the databases before opening them;
the package smoke relocates the Workspace path in its copy so the compiled
binary can open it from an unrelated temporary working directory.

Keep these database bytes unchanged. Replace the fixture only when a future
migration ticket explicitly names a newer compatibility baseline.
