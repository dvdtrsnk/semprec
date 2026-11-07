-- Voice source is assigned only by the trusted voice turn producer; older writers omit it.
ALTER TABLE semp_messages ADD COLUMN source text;
ALTER TABLE semp_messages ADD CONSTRAINT semp_messages_source_check CHECK (source IS NULL OR source = 'voice');
