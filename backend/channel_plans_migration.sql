CREATE TABLE IF NOT EXISTS channel_plans (
    id BIGSERIAL PRIMARY KEY,
    year INTEGER NOT NULL,
    channel VARCHAR(40) NOT NULL,
    monthly_plan BIGINT NOT NULL CHECK (monthly_plan >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_channel_plans_year_channel UNIQUE (year, channel)
);

CREATE INDEX IF NOT EXISTS ix_channel_plans_year ON channel_plans (year);
CREATE INDEX IF NOT EXISTS ix_channel_plans_channel ON channel_plans (channel);

CREATE TABLE IF NOT EXISTS category_plans (
    id BIGSERIAL PRIMARY KEY,
    year INTEGER NOT NULL,
    category VARCHAR(40) NOT NULL,
    monthly_plan BIGINT NOT NULL CHECK (monthly_plan >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_category_plans_year_category UNIQUE (year, category)
);

CREATE INDEX IF NOT EXISTS ix_category_plans_year ON category_plans (year);
CREATE INDEX IF NOT EXISTS ix_category_plans_category ON category_plans (category);
