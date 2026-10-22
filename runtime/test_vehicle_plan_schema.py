import unittest
from jsonschema import Draft202012Validator
from runtime.vehicle_plan_schema import vehicle_plan_schema

class PlannerContractTests(unittest.TestCase):
    def setUp(self):
        self.validator=Draft202012Validator(vehicle_plan_schema())
    def valid(self,action):
        return self.validator.is_valid({'intent':'control','actions':[action],'reply':''})
    def test_temperature_requires_explicit_zone_and_value(self):
        self.assertFalse(self.valid({'type':'temperature','value':21}))
        self.assertFalse(self.valid({'type':'temperature','zone':'both'}))
        self.assertTrue(self.valid({'type':'temperature','zone':'both','value':21.5}))
    def test_rejects_irrelevant_and_missing_arguments(self):
        self.assertFalse(self.valid({'type':'seatHeat','zone':'driver','value':3}))
        self.assertFalse(self.valid({'type':'undo','value':True}))
        self.assertFalse(self.valid({'type':'ac'}))
        self.assertFalse(self.valid({'type':'fan','value':2.5}))
    def test_preserves_all_supported_action_shapes(self):
        actions=[{'type':'fan','value':5},{'type':'ac','value':False},
                 {'type':'defrost','value':True},{'type':'seatHeat','value':0},
                 {'type':'volume','value':45},{'type':'media','value':'next'},
                 {'type':'navigate','value':'서울역'},{'type':'navigationStop'},
                 {'type':'undo'}]
        for action in actions:
            with self.subTest(action=action):self.assertTrue(self.valid(action))
    def test_schema_is_valid(self):
        Draft202012Validator.check_schema(vehicle_plan_schema())

if __name__=='__main__':unittest.main()
