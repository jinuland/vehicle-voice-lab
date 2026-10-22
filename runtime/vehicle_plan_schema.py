"""Match planner decoding to the vehicle executor's action argument contract.

A generic union with only 'type' required permits temperature without a zone
and irrelevant zone/value fields on other actions. Reject those shapes during
decoding, before the executor's existing validation and explicit-bound guards.
"""
def vehicle_plan_schema(version='typed-actions-v2'):
    if version not in ('typed-actions-v2','legacy-generic-v1'):
        raise ValueError('Unknown planner schema version')
    def action(kind,fields=None):
        fields=fields or {}
        return {'type':'object','additionalProperties':False,
                'properties':{'type':{'const':kind},**fields},
                'required':['type',*fields]}
    number={'type':'number'}
    boolean={'type':'boolean'}
    choices=[
        action('temperature',{'zone':{'enum':['driver','passenger','both']},'value':number}),
        action('fan',{'value':{'type':'integer'}}),
        action('ac',{'value':boolean}),
        action('defrost',{'value':boolean}),
        action('seatHeat',{'value':{'type':'integer'}}),
        action('media',{'value':{'enum':['play','pause','next']}}),
        action('volume',{'value':{'type':'integer'}}),
        action('navigate',{'value':{'type':'string'}}),
        action('navigationStop'),action('undo'),
    ]
    schema={'type':'object','additionalProperties':False,
            'required':['intent','actions','reply'],
            'properties':{'intent':{'enum':['control','question','clarify']},
                          'actions':{'type':'array','maxItems':6,'items':{'oneOf':choices}},
                          'reply':{'type':'string','maxLength':350}}}
    if version=='legacy-generic-v1':
        # Retained only to reproduce the archived before-fix measurements.
        schema['properties']['actions']['items']={
            'type':'object','additionalProperties':False,'required':['type'],
            'properties':{'type':{'enum':[c['properties']['type']['const'] for c in choices]},
                          'zone':{'enum':['driver','passenger','both']},
                          'value':{'anyOf':[number,boolean,{'type':'string'}]}}}
    return schema
