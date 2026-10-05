CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE turns (id TEXT PRIMARY KEY NOT NULL, event_id TEXT, checkpoint_ref TEXT);
CREATE INDEX idx_turns_event_id ON turns(event_id);
INSERT INTO session_metadata VALUES ('defaultChatProviderData', '{"sdkSessionId":"00000000-0000-4000-8000-000000000008","model":{"id":"model-x","config":{"thinkingLevel":"high"}}}');
INSERT INTO session_metadata VALUES ('configValues', '{"autoApprove":"default","mode":"interactive","isolation":"folder","branch":"main"}');
INSERT INTO session_metadata VALUES ('customTitleSource', 'auto');
INSERT INTO session_metadata VALUES ('titleGenerationStrategy', 'deferred');
INSERT INTO session_metadata VALUES ('peerChats', '[]');
