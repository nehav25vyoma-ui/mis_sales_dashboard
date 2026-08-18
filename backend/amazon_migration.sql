CREATE TABLE IF NOT EXISTS amazon_dataset_rows (
    id SERIAL PRIMARY KEY,
    upload_id VARCHAR(36) NOT NULL REFERENCES upload_history(upload_id) ON DELETE CASCADE,
    source_row_number INTEGER NOT NULL,
    product_name VARCHAR(500),
    category VARCHAR(100),
    amount VARCHAR(100),
    currency VARCHAR(30),
    state VARCHAR(200),
    row_data JSON NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_amazon_dataset_rows_upload_id
    ON amazon_dataset_rows (upload_id);
