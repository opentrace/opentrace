def process():
    validate()
    transform()
    save()

def run():
    self.setup()
    db.connect()
    logger.info("done")
